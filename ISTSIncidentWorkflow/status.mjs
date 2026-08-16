import fs from "node:fs";
import { defaultActivationPaths, OpenClawCommand } from "./activation.mjs";
import { COLLEAGUE_ZONE_URL } from "./definition.mjs";
import { assertPrivateFile, polarResearchAuthorized, readPrivateGrant } from "./grant.mjs";

export function readActivationStatus(options = {}) {
  const paths = Object.freeze({ ...defaultActivationPaths(options.homeDirectory), ...(options.paths ?? {}) });
  const command = options.command ?? new OpenClawCommand(options.openclawPath);
  const status = {
    schema: "rico.ists-incident-activation-status",
    schemaVersion: 1,
    state: "not-installed",
    installed: false,
    configuredEnabled: false,
    monitorConfiguredEnabled: false,
    live: false,
    restartRequired: false,
    groupIngress: {
      mode: "not-installed",
      adapterInstalled: false,
      authorized: false,
      configuredEnabled: false,
      live: false,
      state: "not-installed",
      lastErrorCode: null,
      generalRicoPolicyBroadened: false,
      nativeAllowlistBroadened: false,
    },
    exactScope: {
      grantVersion: null,
      ownerBound: false,
      jeffBound: false,
      incidentGroupBound: false,
      incidentQueryGroupCount: 0,
      anyLocalGroupAuthorized: false,
    },
    privateFilesReady: false,
    monitor: {
      pollIntervalSeconds: 180,
      lastPollAt: null,
      lastErrorCode: null,
      alertsConfirmed: 0,
      deliveryUnknown: 0,
      researchAccepted: 0,
    },
    colleagueZone: {
      enabled: false,
      state: "disabled",
      reauthRequired: false,
      reauthURL: null,
      reauthMethod: null,
    },
    blocker: "activation_not_installed",
  };

  let manifest;
  try {
    assertPrivateFile(paths.manifestPath);
    manifest = JSON.parse(fs.readFileSync(paths.manifestPath, "utf8"));
    if (manifest?.schema !== "rico.ists-incident-activation" || manifest.schemaVersion !== 1) {
      throw coded("activation_manifest_invalid");
    }
    status.installed = true;
    status.state = manifest.state;
  } catch (error) {
    if (!fs.existsSync(paths.manifestPath)) return Object.freeze(status);
    status.state = "blocked";
    status.blocker = safeCode(error);
    return Object.freeze(status);
  }

  try {
    const grant = readPrivateGrant(manifest.permissionFile);
    const anyLocalGroupAuthorized = grant.schemaVersion === 2
      && grant.imessage.anyLocalGroup === true
      && polarResearchAuthorized(grant);
    status.exactScope = {
      grantVersion: grant.schemaVersion,
      ownerBound: grant.schemaVersion === 2 && Boolean(grant.owner),
      jeffBound: Boolean(grant.jeff?.profileId && grant.jeff?.principal),
      incidentGroupBound: Boolean(grant.incidentChat?.chatId && grant.incidentChat?.participantSnapshotSha256),
      incidentQueryGroupCount: Array.isArray(grant.incidentQueryGroups) ? grant.incidentQueryGroups.length : 0,
      anyLocalGroupAuthorized,
    };
    assertPrivateFile(manifest.adapterModule);
    status.groupIngress.authorized = anyLocalGroupAuthorized;
    status.groupIngress.mode = anyLocalGroupAuthorized
      ? "dedicated-ists-only-any-local-group"
      : "recipient-guard-reviewed-groups-only";
    status.groupIngress.state = anyLocalGroupAuthorized ? "installed-disabled" : "not-authorized";
    if (anyLocalGroupAuthorized) {
      if (!manifest.anyGroupAdapterModule) throw coded("any_group_adapter_missing");
      assertPrivateFile(manifest.anyGroupAdapterModule);
      status.groupIngress.adapterInstalled = true;
    } else if (manifest.anyGroupAdapterModule) {
      throw coded("any_group_adapter_unexpected");
    }
    if (grant.colleagueZone.enabled) {
      if (!manifest.colleagueZoneAdapterModule) throw coded("colleague_zone_adapter_missing");
      assertPrivateFile(manifest.colleagueZoneAdapterModule);
    }
    status.privateFilesReady = status.exactScope.ownerBound
      && status.exactScope.jeffBound
      && status.exactScope.incidentGroupBound
      && (status.exactScope.incidentQueryGroupCount > 0 || anyLocalGroupAuthorized)
      && (!anyLocalGroupAuthorized || status.groupIngress.adapterInstalled);
    status.colleagueZone.enabled = grant.colleagueZone.enabled;
    status.colleagueZone.state = grant.colleagueZone.enabled ? "configured" : "disabled";
    if (!status.privateFilesReady) throw coded("exact_scope_incomplete");
  } catch (error) {
    status.state = "blocked";
    status.blocker = safeCode(error);
    return Object.freeze(status);
  }

  try {
    const entry = JSON.parse(command.run(["config", "get", "plugins.entries.rico-ists-incident", "--json"]));
    status.monitorConfiguredEnabled = entry?.enabled === true && entry?.config?.enabled === true;
    status.groupIngress.configuredEnabled = entry?.enabled === true
      && entry?.config?.anyGroupEnabled === true
      && status.groupIngress.authorized;
    status.configuredEnabled = status.monitorConfiguredEnabled || status.groupIngress.configuredEnabled;
    const configuredAnyGroupPath = String(entry?.config?.anyGroupAdapterModule ?? "").trim();
    if (status.groupIngress.authorized) {
      if (configuredAnyGroupPath !== manifest.anyGroupAdapterModule) throw coded("any_group_adapter_configuration_mismatch");
    } else if (configuredAnyGroupPath) {
      throw coded("any_group_adapter_configuration_unexpected");
    }
  } catch (error) {
    status.blocker = error?.code ? safeCode(error) : "plugin_configuration_unavailable";
    status.state = "blocked";
    return Object.freeze(status);
  }

  try {
    const live = JSON.parse(command.run([
      "gateway",
      "call",
      "rico.ists-incident.status",
      "--json",
      "--timeout",
      "10000",
    ]));
    status.live = true;
    if (live.generalRicoPolicyBroadened !== false || live.nativeAllowlistBroadened !== false) {
      status.state = "blocked";
      status.blocker = "any_group_policy_boundary_unproven";
      return deepFreeze(status);
    }
    status.monitor = {
      pollIntervalSeconds: integer(live.pollIntervalSeconds, 180),
      lastPollAt: isoOrNull(live.lastPollAt),
      lastErrorCode: safeNullableCode(live.lastErrorCode),
      alertsConfirmed: integer(live.alertsConfirmed, 0),
      deliveryUnknown: integer(live.deliveryUnknown, 0),
      researchAccepted: integer(live.researchAccepted, 0),
    };
    status.colleagueZone.state = safeState(live.colleagueZoneState, status.colleagueZone.state);
    const liveAnyGroupAuthorized = live.anyLocalGroupAuthorized === true;
    status.groupIngress.state = safeState(live.anyLocalGroupState, status.groupIngress.state);
    status.groupIngress.lastErrorCode = safeNullableCode(live.anyLocalGroupLastErrorCode);
    status.groupIngress.live = status.groupIngress.authorized
      && live.anyLocalGroupEnabled === true
      && liveAnyGroupAuthorized
      && live.anyLocalGroupInstalled === true
      && live.anyLocalGroupLive === true
      && new Set(["baseline", "running", "attention"]).has(status.groupIngress.state);
    if (!status.groupIngress.authorized && liveAnyGroupAuthorized) {
      status.state = "blocked";
      status.blocker = "any_group_live_authority_mismatch";
      return deepFreeze(status);
    }
    status.colleagueZone.reauthRequired = live.colleagueZoneReauthRequired === true;
    if (status.colleagueZone.reauthRequired) {
      status.colleagueZone.reauthURL = live.colleagueZoneReauthURL === COLLEAGUE_ZONE_URL
        ? COLLEAGUE_ZONE_URL
        : null;
      status.colleagueZone.reauthMethod = live.colleagueZoneReauthMethod === "dedicated-browser"
        ? "dedicated-browser"
        : null;
      if (!status.colleagueZone.reauthURL || !status.colleagueZone.reauthMethod) {
        status.state = "blocked";
        status.blocker = "colleague_zone_reauth_descriptor_invalid";
        return deepFreeze(status);
      }
    }
    const liveMonitorEnabled = live.monitorEnabled === true
      || (live.monitorEnabled === undefined && live.enabled === true);
    const liveAnyGroupEnabled = live.anyLocalGroupEnabled === true;
    status.restartRequired = liveMonitorEnabled !== status.monitorConfiguredEnabled
      || liveAnyGroupEnabled !== status.groupIngress.configuredEnabled
      || (status.groupIngress.authorized && status.groupIngress.configuredEnabled && !liveAnyGroupAuthorized);
    if (status.restartRequired) {
      status.state = "restart-required";
      status.blocker = "gateway_restart_required";
    } else if (!status.configuredEnabled || live.state === "disabled" || live.state === "stopped") {
      status.state = "disabled";
      status.blocker = "workflow_disabled";
      status.groupIngress.live = false;
      if (status.groupIngress.authorized) status.groupIngress.state = "disabled";
    } else if (live.state === "running") {
      status.state = "running";
      status.blocker = null;
    } else if (status.groupIngress.live) {
      status.state = "attention";
      status.blocker = safeNullableCode(live.lastErrorCode) ?? "monitor_degraded_group_live";
    } else {
      status.state = safeState(live.state, "blocked");
      status.blocker = safeNullableCode(live.lastErrorCode) ?? "monitor_not_running";
    }
  } catch {
    status.restartRequired = status.configuredEnabled;
    status.state = status.configuredEnabled ? "restart-required" : "installed-disabled";
    status.blocker = status.configuredEnabled ? "gateway_restart_required" : "workflow_disabled";
  }
  return deepFreeze(status);
}

export function statusSummary(status) {
  const value = status ?? {};
  return Object.freeze({
    state: safeState(value.state, "unknown"),
    ready: value.state === "running" && value.blocker === null,
    blocker: safeNullableCode(value.blocker),
    scope: value.exactScope?.ownerBound === true
      && value.exactScope?.jeffBound === true
      && value.exactScope?.incidentGroupBound === true
      && (Number(value.exactScope?.incidentQueryGroupCount) > 0
        || value.exactScope?.anyLocalGroupAuthorized === true)
      ? value.exactScope?.anyLocalGroupAuthorized === true
        ? "owner+jeff+incident-source+any-local-group-ists-only"
        : "owner+jeff+incident-query-groups"
      : "incomplete",
    anyLocalGroup: Object.freeze({
      installed: value.groupIngress?.adapterInstalled === true,
      authorized: value.groupIngress?.authorized === true,
      live: value.groupIngress?.live === true,
      state: safeState(value.groupIngress?.state, "unknown"),
    }),
    lastPollAt: isoOrNull(value.monitor?.lastPollAt),
  });
}

function integer(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function isoOrNull(value) {
  if (value === null || value === undefined) return null;
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function safeState(value, fallback) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(normalized) ? normalized : fallback;
}

function safeNullableCode(value) {
  if (value === null || value === undefined || value === "") return null;
  return safeCode(value);
}

function safeCode(value) {
  return String(value?.code ?? value?.message ?? value ?? "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "_")
    .slice(0, 80) || "unknown";
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
