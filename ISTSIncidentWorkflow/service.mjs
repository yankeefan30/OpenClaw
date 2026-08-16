import path from "node:path";
import { pathToFileURL } from "node:url";
import { POLL_INTERVAL_MS } from "./definition.mjs";
import { ISTSIncidentEngine } from "./engine.mjs";
import { ISTSJeffContextProvider } from "./context-provider.mjs";
import { ISTSAnyGroupIngressEngine } from "./any-group-ingress.mjs";
import { AnyGroupIngressStateStore } from "./any-group-state-store.mjs";
import { EscalationHandoffStore } from "./RicoEscalationHandoff/handoff.js";
import { AutomaticIMTRequestRegistry } from "./RicoEscalationHandoff/automatic-imt.mjs";
import {
  assertPrivateFile,
  defaultGrantPath,
  defaultStateDirectory,
  ensurePrivateDirectory,
  polarResearchAuthorized,
  readPrivateGrant,
} from "./grant.mjs";
import { IncidentStateStore } from "./state-store.mjs";

export class ISTSIncidentService {
  constructor({ api, setIntervalFn = setInterval, clearIntervalFn = clearInterval, now = () => new Date() }) {
    this.api = api;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.now = now;
    this.timer = null;
    this.running = null;
    this.engine = null;
    this.anyGroupEngine = null;
    this.contextProvider = null;
    this.snapshot = {
      schema: "rico.ists-incident-status",
      schemaVersion: 1,
      state: "stopped",
      enabled: this.api.pluginConfig?.enabled === true || this.api.pluginConfig?.anyGroupEnabled === true,
      monitorEnabled: this.api.pluginConfig?.enabled === true,
      anyLocalGroupEnabled: this.api.pluginConfig?.anyGroupEnabled === true,
      pollIntervalSeconds: POLL_INTERVAL_MS / 1_000,
      lastPollAt: null,
      lastErrorCode: null,
      alertsConfirmed: 0,
      deliveryUnknown: 0,
      suppressedCooldown: 0,
      researchAccepted: 0,
      colleagueZoneState: "disabled",
      colleagueZoneReauthRequired: false,
      colleagueZoneReauthURL: null,
      colleagueZoneReauthMethod: null,
      anyLocalGroupAuthorized: false,
      anyLocalGroupInstalled: false,
      anyLocalGroupLive: false,
      anyLocalGroupState: "disabled",
      anyLocalGroupLastErrorCode: null,
      anyLocalGroupBaseline: false,
      anyLocalGroupInspected: 0,
      anyLocalGroupQualified: 0,
      anyLocalGroupDelivered: 0,
      anyLocalGroupOutcomeUnknown: 0,
      generalRicoPolicyBroadened: false,
      nativeAllowlistBroadened: false,
    };
  }

  status() {
    return Object.freeze({ ...this.snapshot });
  }

  getContextProvider() {
    if (!this.contextProvider) throw coded("ists_context_provider_unavailable");
    return this.contextProvider;
  }

  async start() {
    const monitorEnabled = this.api.pluginConfig?.enabled === true;
    const anyLocalGroupEnabled = this.api.pluginConfig?.anyGroupEnabled === true;
    if (!monitorEnabled && !anyLocalGroupEnabled) {
      this.snapshot = {
        ...this.snapshot,
        state: "disabled",
        enabled: false,
        monitorEnabled: false,
        anyLocalGroupEnabled: false,
      };
      return;
    }
    this.snapshot = {
      ...this.snapshot,
      state: "starting",
      enabled: true,
      monitorEnabled,
      anyLocalGroupEnabled,
    };
    await this.tick();
    this.timer = this.setIntervalFn(() => void this.tick(), POLL_INTERVAL_MS);
  }

  async stop() {
    if (this.timer !== null) this.clearIntervalFn(this.timer);
    this.timer = null;
    if (this.running) await this.running;
    this.snapshot = { ...this.snapshot, state: "stopped" };
  }

  async tick() {
    if (this.running) return this.running;
    this.running = this.performTick();
    try {
      return await this.running;
    } finally {
      this.running = null;
    }
  }

  async performTick() {
    const lastPollAt = this.now().toISOString();
    let result = null;
    let monitorError = null;
    if (this.api.pluginConfig?.enabled === true) {
      try {
        if (!this.engine) await this.loadMonitorRuntime();
        result = await this.engine.runOnce();
      } catch (error) {
        monitorError = error;
      }
    }

    let anyGroupResult = null;
    let anyGroupError = null;
    if (this.api.pluginConfig?.anyGroupEnabled === true) {
      try {
        if (!this.anyGroupEngine) await this.loadAnyGroupRuntime();
        anyGroupResult = await this.anyGroupEngine.runOnce();
      } catch (error) {
        anyGroupError = error;
      }
    }

    const monitorCode = monitorError ? safeCode(monitorError) : null;
    const anyGroupCode = anyGroupError ? safeCode(anyGroupError) : null;
    const deliveryAttention = (result?.deliveryUnknown ?? 0) > 0
      || (anyGroupResult?.outcomeUnknown ?? 0) > 0;
    const groupRunning = Boolean(this.anyGroupEngine && anyGroupResult && !anyGroupError);
    const blocked = Boolean(anyGroupError || (monitorError && !groupRunning));
    const reauthError = [monitorError, anyGroupError]
      .find((error) => safeCode(error) === "colleague_zone_reauth_required");
    const reauth = reauthError?.reauth ?? null;
    const anyGroupState = anyGroupError
        ? "blocked"
      : !this.anyGroupEngine
        ? "disabled"
        : anyGroupResult?.baseline === true
          ? "baseline"
          : (anyGroupResult?.outcomeUnknown ?? 0) > 0
            ? "attention"
            : "running";
    this.snapshot = {
      ...this.snapshot,
      state: blocked ? "blocked" : (monitorError || deliveryAttention) ? "attention" : "running",
      lastPollAt,
      lastErrorCode: monitorCode ?? anyGroupCode ?? (deliveryAttention ? "delivery_outcome_unknown" : null),
      alertsConfirmed: this.snapshot.alertsConfirmed + (result?.alertsConfirmed ?? 0),
      deliveryUnknown: this.snapshot.deliveryUnknown + (result?.deliveryUnknown ?? 0),
      suppressedCooldown: this.snapshot.suppressedCooldown + (result?.suppressedCooldown ?? 0),
      researchAccepted: this.snapshot.researchAccepted + (result?.research === "accepted" ? 1 : 0),
      colleagueZoneState: reauth
        ? "reauth-required"
        : this.engine?.grant?.colleagueZone?.enabled === true ? "ready" : "disabled",
      colleagueZoneReauthRequired: Boolean(reauth),
      colleagueZoneReauthURL: reauth?.url ?? null,
      colleagueZoneReauthMethod: reauth ? "dedicated-browser" : null,
      enabled: this.api.pluginConfig?.enabled === true || this.api.pluginConfig?.anyGroupEnabled === true,
      monitorEnabled: this.api.pluginConfig?.enabled === true,
      anyLocalGroupEnabled: this.api.pluginConfig?.anyGroupEnabled === true,
      anyLocalGroupAuthorized: this.snapshot.anyLocalGroupAuthorized || this.anyGroupEngine !== null,
      anyLocalGroupInstalled: this.anyGroupEngine !== null,
      anyLocalGroupLive: Boolean(this.anyGroupEngine && anyGroupResult),
      anyLocalGroupState: anyGroupState,
      anyLocalGroupLastErrorCode: anyGroupCode,
      anyLocalGroupBaseline: anyGroupResult?.baseline === true,
      anyLocalGroupInspected: this.snapshot.anyLocalGroupInspected + (anyGroupResult?.inspected ?? 0),
      anyLocalGroupQualified: this.snapshot.anyLocalGroupQualified + (anyGroupResult?.qualified ?? 0),
      anyLocalGroupDelivered: this.snapshot.anyLocalGroupDelivered + (anyGroupResult?.delivered ?? 0),
      anyLocalGroupOutcomeUnknown: this.snapshot.anyLocalGroupOutcomeUnknown + (anyGroupResult?.outcomeUnknown ?? 0),
      generalRicoPolicyBroadened: false,
      nativeAllowlistBroadened: false,
    };
    if (monitorError || anyGroupError) {
      const code = monitorCode ?? anyGroupCode;
      this.api.logger?.error?.(`ISTS incident workflow blocked (${code})`);
    }
    return Object.freeze({
      status: this.snapshot.state,
      monitor: result ?? (monitorError ? { status: "blocked", errorCode: monitorCode } : null),
      anyLocalGroup: anyGroupResult ?? (anyGroupError ? { status: "blocked", errorCode: anyGroupCode } : null),
    });
  }

  async loadRuntime() {
    return this.loadMonitorRuntime();
  }

  async loadMonitorRuntime() {
    const permissionFile = absoluteConfigPath(this.api, "permissionFile", defaultGrantPath());
    const stateDirectory = absoluteConfigPath(this.api, "stateDirectory", defaultStateDirectory());
    const adapterModule = absoluteConfigPath(this.api, "adapterModule");
    assertPrivateFile(adapterModule);
    ensurePrivateDirectory(stateDirectory);
    const permissionGrant = readPrivateGrant(permissionFile);
    let colleagueZoneAdapter = null;
    if (permissionGrant.colleagueZone.enabled) {
      const colleagueZoneAdapterModule = absoluteConfigPath(this.api, "colleagueZoneAdapterModule");
      if (colleagueZoneAdapterModule === adapterModule) throw coded("colleague_zone_adapter_must_be_separate");
      assertPrivateFile(colleagueZoneAdapterModule);
      const sourceImported = await import(`${pathToFileURL(colleagueZoneAdapterModule).href}?v=${Date.now()}`);
      if (typeof sourceImported.createColleagueZoneStatusAdapter !== "function") throw coded("colleague_zone_adapter_factory_missing");
      colleagueZoneAdapter = await sourceImported.createColleagueZoneStatusAdapter({
        source: permissionGrant.colleagueZone,
        stateDirectory,
        sessionPolicy: {
          interactiveReauthOnly: true,
          passwordOrOTPAutomationAllowed: false,
          browserCookieInspectionOrExportAllowed: false,
          sessionStorage: "browser-managed-dedicated-profile",
          daemonHeadlessReadAllowed: true,
        },
      });
    }
    const imported = await import(`${pathToFileURL(adapterModule).href}?v=${Date.now()}`);
    if (typeof imported.createISTSIncidentAdapter !== "function") throw coded("adapter_factory_missing");
    const adapter = await imported.createISTSIncidentAdapter({
      api: this.api,
      permissionGrant,
      stateDirectory,
    });
    const store = new IncidentStateStore(path.join(stateDirectory, "state.json"));
    this.engine = new ISTSIncidentEngine({ permissionGrant, adapter, colleagueZoneAdapter, store, now: this.now });
    this.contextProvider = new ISTSJeffContextProvider({ permissionGrant, adapter, colleagueZoneAdapter });
  }

  async loadAnyGroupRuntime() {
    const permissionFile = absoluteConfigPath(this.api, "permissionFile", defaultGrantPath());
    const stateDirectory = absoluteConfigPath(this.api, "stateDirectory", defaultStateDirectory());
    ensurePrivateDirectory(stateDirectory);
    const permissionGrant = readPrivateGrant(permissionFile);
    const anyLocalGroupAuthorized = permissionGrant.schemaVersion === 2
      && permissionGrant.imessage.anyLocalGroup === true
      && polarResearchAuthorized(permissionGrant);
    this.snapshot = {
      ...this.snapshot,
      anyLocalGroupAuthorized,
      anyLocalGroupInstalled: false,
      anyLocalGroupLive: false,
      anyLocalGroupState: anyLocalGroupAuthorized ? "starting" : "disabled",
      anyLocalGroupLastErrorCode: null,
    };
    if (!anyLocalGroupAuthorized) throw coded("any_local_group_not_authorized");
    const anyGroupAdapterModule = absoluteConfigPath(this.api, "anyGroupAdapterModule");
    const configuredMainAdapter = String(this.api.pluginConfig?.adapterModule ?? "").trim();
    const configuredColleagueZoneAdapter = String(this.api.pluginConfig?.colleagueZoneAdapterModule ?? "").trim();
    if (anyGroupAdapterModule === configuredMainAdapter || anyGroupAdapterModule === configuredColleagueZoneAdapter) {
      throw coded("any_group_adapter_must_be_separate");
    }
    assertPrivateFile(anyGroupAdapterModule);
    const anyGroupImported = await import(`${pathToFileURL(anyGroupAdapterModule).href}?v=${Date.now()}`);
    if (typeof anyGroupImported.createISTSAnyLocalGroupAdapter !== "function") {
      throw coded("any_group_adapter_factory_missing");
    }
    const anyGroupAdapter = await anyGroupImported.createISTSAnyLocalGroupAdapter({
      api: this.api,
      permissionGrant,
      stateDirectory,
    });
    const anyGroupStore = new AnyGroupIngressStateStore(path.join(stateDirectory, "any-group-state.json"));
    this.anyGroupEngine = new ISTSAnyGroupIngressEngine({
      permissionGrant,
      groupAdapter: anyGroupAdapter,
      store: anyGroupStore,
      handoffStore: new EscalationHandoffStore(),
      requestRegistry: new AutomaticIMTRequestRegistry(),
      now: this.now,
    });
    this.snapshot = {
      ...this.snapshot,
      anyLocalGroupInstalled: true,
      anyLocalGroupState: "ready",
    };
  }

  markBlocked(error, at = this.snapshot.lastPollAt) {
    const code = safeCode(error);
    const changed = this.snapshot.state !== "blocked" || this.snapshot.lastErrorCode !== code;
    const reauth = code === "colleague_zone_reauth_required" ? error?.reauth : null;
    this.snapshot = {
      ...this.snapshot,
      state: "blocked",
      lastPollAt: at,
      lastErrorCode: code,
      colleagueZoneState: reauth ? "reauth-required" : this.snapshot.colleagueZoneState,
      colleagueZoneReauthRequired: Boolean(reauth),
      colleagueZoneReauthURL: reauth?.url ?? null,
      colleagueZoneReauthMethod: reauth ? "dedicated-browser" : null,
      anyLocalGroupState: this.snapshot.anyLocalGroupAuthorized ? "blocked" : this.snapshot.anyLocalGroupState,
      anyLocalGroupLastErrorCode: this.snapshot.anyLocalGroupAuthorized ? code : this.snapshot.anyLocalGroupLastErrorCode,
      anyLocalGroupLive: false,
    };
    if (changed) this.api.logger?.error?.(`ISTS incident workflow blocked (${code})`);
  }
}

function absoluteConfigPath(api, key, fallback) {
  const value = String(api.pluginConfig?.[key] ?? fallback ?? "").trim();
  if (!value || !path.isAbsolute(value)) throw coded(`${key}_absolute_path_required`);
  return path.normalize(value);
}

function safeCode(error) {
  return String(error?.code ?? error?.name ?? "unknown").toLowerCase().replace(/[^a-z0-9_-]+/gu, "_").slice(0, 80) || "unknown";
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
