import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  acquireNativeConfigLease,
  applyConfigurationCAS,
  defaultActivationPaths,
  enableActivation,
  installActivation,
  verifyPluginClosure,
} from "../activation.mjs";
import {
  incidentGroupMemberFingerprint,
  participantSnapshotSha256,
} from "../grant.mjs";
import { runCLI } from "../scripts/ists-incident.mjs";
import { readActivationStatus } from "../status.mjs";
import { COLLEAGUE_ZONE_SOURCE_ID, COLLEAGUE_ZONE_URL } from "../definition.mjs";
import { PARTICIPANTS, permissionGrant } from "./fixtures.mjs";

function scopedGrant({ anyLocalGroup = false, includeReviewedGroup = true } = {}) {
  const hash = participantSnapshotSha256(PARTICIPANTS);
  const target = "chat_id:77";
  return permissionGrant({
    schemaVersion: 2,
    imessage: { anyLocalGroup },
    owner: { profileId: "fixture-owner-profile", principal: PARTICIPANTS[1] },
    incidentChat: {
      participantRevision: `sha256:${hash}`,
      participantSnapshotSha256: hash,
    },
    incidentQueryGroups: includeReviewedGroup ? [{
      target,
      groupRevision: `sha256:${hash}`,
      participants: PARTICIPANTS,
      participantSnapshotSha256: hash,
      memberFingerprint: incidentGroupMemberFingerprint(target, PARTICIPANTS),
    }] : [],
    colleagueZone: {
      enabled: true,
      sourceId: COLLEAGUE_ZONE_SOURCE_ID,
      pageUrl: COLLEAGUE_ZONE_URL,
      profileId: "fixture-colleague-zone-profile",
    },
  });
}

function temporaryHome() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rico-ists-activation-"));
  fs.chmodSync(directory, 0o700);
  fs.mkdirSync(path.join(directory, ".openclaw"), { mode: 0o700 });
  fs.writeFileSync(path.join(directory, ".openclaw", "openclaw.json"), "{}\n", { mode: 0o600 });
  return { directory, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

class FakeCommand {
  constructor(live = {}, entry = { enabled: true, config: { enabled: true } }) {
    this.live = live;
    this.entry = entry;
    this.calls = [];
  }
  run(argv) {
    this.calls.push(argv);
    if (argv[0] === "config" && argv[1] === "get") {
      return JSON.stringify(this.entry);
    }
    if (argv[0] === "gateway" && argv[1] === "call") return JSON.stringify(this.live);
    return "";
  }
  setBatch(operations, options = {}) { this.calls.push(["setBatch", operations, options]); }
  validateConfig() { this.calls.push(["validateConfig"]); return { valid: true }; }
}

test("activation installs a disabled private runtime with the bundled Colleague Zone closure", () => {
  const temp = temporaryHome();
  try {
    const command = new FakeCommand();
    const result = installActivation({
      schema: "rico.ists-incident-activation-request",
      schemaVersion: 1,
      permissionGrant: scopedGrant(),
      colleagueZoneAdapterModule: null,
    }, {
      homeDirectory: temp.directory,
      pluginSourceDirectory: path.resolve(new URL("..", import.meta.url).pathname),
      command,
    });
    const paths = defaultActivationPaths(temp.directory);
    assert.equal(result.state, "installed-disabled");
    assert.equal(result.monitoringEnabled, false);
    assert.equal(result.groupIngress, "recipient-guard-reviewed-groups-only");
    assert.equal(result.anyLocalGroupInstalled, false);
    assert.equal(result.anyLocalGroupAuthorized, false);
    assert.equal(result.generalRicoPolicyBroadened, false);
    assert.equal(result.nativeAllowlistBroadened, false);
    for (const filePath of [
      paths.grantPath,
      paths.mainAdapterPath,
      paths.colleagueZoneAdapterPath,
      path.join(paths.adapterRuntimeDirectory, "colleague-zone-adapter", "browser-runtime.mjs"),
      paths.colleagueZoneReauthPath,
      path.join(paths.adapterRuntimeDirectory, "definition.mjs"),
    ]) {
      const stat = fs.lstatSync(filePath);
      assert.equal(stat.isFile() && !stat.isSymbolicLink(), true);
      assert.equal(stat.mode & 0o777, 0o600);
    }
    const manifest = JSON.parse(fs.readFileSync(paths.manifestPath, "utf8"));
    assert.equal(manifest.colleagueZoneAdapterModule, paths.colleagueZoneAdapterPath);
    assert.equal(command.calls.some((call) => call[0] === "plugins" && call[1] === "install"), true);
    assert.equal(verifyPluginClosure(path.resolve(new URL("..", import.meta.url).pathname)).length >= 20, true);
  } finally {
    temp.cleanup();
  }
});

test("status exposes only the fixed reauthentication URL and method", () => {
  const temp = temporaryHome();
  try {
    installActivation({
      schema: "rico.ists-incident-activation-request",
      schemaVersion: 1,
      permissionGrant: scopedGrant(),
      colleagueZoneAdapterModule: null,
    }, {
      homeDirectory: temp.directory,
      pluginSourceDirectory: path.resolve(new URL("..", import.meta.url).pathname),
      command: new FakeCommand(),
    });
    const live = {
      enabled: true,
      state: "reauth-required",
      pollIntervalSeconds: 180,
      lastPollAt: null,
      lastErrorCode: "colleague_zone_reauth_required",
      alertsConfirmed: 0,
      deliveryUnknown: 0,
      researchAccepted: 0,
      colleagueZoneState: "reauth-required",
      colleagueZoneReauthRequired: true,
      colleagueZoneReauthURL: COLLEAGUE_ZONE_URL,
      colleagueZoneReauthMethod: "dedicated-browser",
      anyLocalGroupAuthorized: false,
      anyLocalGroupInstalled: false,
      monitorEnabled: true,
      anyLocalGroupEnabled: false,
      anyLocalGroupLive: false,
      anyLocalGroupState: "disabled",
      anyLocalGroupLastErrorCode: null,
      generalRicoPolicyBroadened: false,
      nativeAllowlistBroadened: false,
    };
    const status = readActivationStatus({
      homeDirectory: temp.directory,
      command: new FakeCommand(live),
    });
    assert.equal(status.colleagueZone.reauthRequired, true);
    assert.equal(status.colleagueZone.reauthURL, COLLEAGUE_ZONE_URL);
    assert.equal(status.colleagueZone.reauthMethod, "dedicated-browser");
    assert.equal(status.exactScope.incidentQueryGroupCount, 1);
    assert.equal(status.groupIngress.adapterInstalled, false);
    assert.equal(status.groupIngress.authorized, false);
    assert.equal(status.groupIngress.live, false);
    assert.equal(status.groupIngress.generalRicoPolicyBroadened, false);

    const unsafe = readActivationStatus({
      homeDirectory: temp.directory,
      command: new FakeCommand({ ...live, colleagueZoneReauthURL: "https://example.test/credential" }),
    });
    assert.equal(unsafe.state, "blocked");
    assert.equal(unsafe.blocker, "colleague_zone_reauth_descriptor_invalid");
    assert.equal(unsafe.colleagueZone.reauthURL, null);
  } finally {
    temp.cleanup();
  }
});

test("activation privately installs and configures the dedicated any-local-group adapter only with explicit authority", async () => {
  const temp = temporaryHome();
  try {
    const command = new FakeCommand();
    const result = installActivation({
      schema: "rico.ists-incident-activation-request",
      schemaVersion: 1,
      permissionGrant: scopedGrant({ anyLocalGroup: true, includeReviewedGroup: false }),
      colleagueZoneAdapterModule: null,
    }, {
      homeDirectory: temp.directory,
      pluginSourceDirectory: path.resolve(new URL("..", import.meta.url).pathname),
      command,
    });
    const paths = defaultActivationPaths(temp.directory);
    assert.equal(result.groupIngress, "dedicated-ists-only-any-local-group");
    assert.equal(result.anyLocalGroupInstalled, true);
    assert.equal(result.anyLocalGroupAuthorized, true);
    for (const filePath of [
      paths.anyGroupAdapterPath,
      path.join(paths.adapterRuntimeDirectory, "any-group-contracts.mjs"),
      path.join(paths.adapterRuntimeDirectory, "any-group-source.mjs"),
      path.join(paths.adapterRuntimeDirectory, "contracts.mjs"),
      path.join(paths.adapterRuntimeDirectory, "RicoEscalationHandoff", "result-contract.js"),
    ]) {
      const stat = fs.lstatSync(filePath);
      assert.equal(stat.isFile() && !stat.isSymbolicLink(), true);
      assert.equal(stat.mode & 0o777, 0o600);
    }
    const installedAdapter = await import(`${pathToFileURL(paths.anyGroupAdapterPath).href}?test=${Date.now()}`);
    assert.equal(typeof installedAdapter.createISTSAnyLocalGroupAdapter, "function");
    const manifest = JSON.parse(fs.readFileSync(paths.manifestPath, "utf8"));
    assert.equal(manifest.anyGroupAdapterModule, paths.anyGroupAdapterPath);
    const configured = command.calls
      .filter((call) => call[0] === "setBatch")
      .flatMap((call) => call[1])
      .find((operation) => operation.path === "plugins.entries.rico-ists-incident.config");
    assert.equal(configured.value.anyGroupAdapterModule, paths.anyGroupAdapterPath);
    assert.equal(configured.value.anyGroupEnabled, false);

    enableActivation({ homeDirectory: temp.directory, command });
    const enabledConfiguration = command.calls
      .filter((call) => call[0] === "setBatch" && call[2]?.dryRun !== true)
      .flatMap((call) => call[1])
      .filter((operation) => operation.path === "plugins.entries.rico-ists-incident.config")
      .at(-1);
    assert.equal(enabledConfiguration.value.enabled, true);
    assert.equal(enabledConfiguration.value.anyGroupEnabled, true);
  } finally {
    temp.cleanup();
  }
});

test("status distinguishes any-local-group installed, authorized, and live without broadening Rico policy", () => {
  const temp = temporaryHome();
  try {
    installActivation({
      schema: "rico.ists-incident-activation-request",
      schemaVersion: 1,
      permissionGrant: scopedGrant({ anyLocalGroup: true, includeReviewedGroup: false }),
      colleagueZoneAdapterModule: null,
    }, {
      homeDirectory: temp.directory,
      pluginSourceDirectory: path.resolve(new URL("..", import.meta.url).pathname),
      command: new FakeCommand(),
    });
    const paths = defaultActivationPaths(temp.directory);
    const live = {
      enabled: true,
      state: "running",
      pollIntervalSeconds: 180,
      lastPollAt: "2026-08-15T12:10:00.000Z",
      lastErrorCode: null,
      alertsConfirmed: 0,
      deliveryUnknown: 0,
      researchAccepted: 0,
      colleagueZoneState: "ready",
      colleagueZoneReauthRequired: false,
      colleagueZoneReauthURL: null,
      colleagueZoneReauthMethod: null,
      anyLocalGroupAuthorized: true,
      anyLocalGroupInstalled: true,
      monitorEnabled: false,
      anyLocalGroupEnabled: true,
      anyLocalGroupLive: true,
      anyLocalGroupState: "running",
      anyLocalGroupLastErrorCode: null,
      generalRicoPolicyBroadened: false,
      nativeAllowlistBroadened: false,
    };
    const entry = {
      enabled: true,
      config: { enabled: false, anyGroupEnabled: true, anyGroupAdapterModule: paths.anyGroupAdapterPath },
    };
    const status = readActivationStatus({ homeDirectory: temp.directory, command: new FakeCommand(live, entry) });
    assert.equal(status.state, "running");
    assert.equal(status.groupIngress.adapterInstalled, true);
    assert.equal(status.groupIngress.authorized, true);
    assert.equal(status.groupIngress.live, true);
    assert.equal(status.groupIngress.generalRicoPolicyBroadened, false);
    assert.equal(status.groupIngress.nativeAllowlistBroadened, false);
    assert.equal(status.exactScope.incidentQueryGroupCount, 0);
    assert.equal(status.privateFilesReady, true);

    const broadened = readActivationStatus({
      homeDirectory: temp.directory,
      command: new FakeCommand({ ...live, generalRicoPolicyBroadened: true }, entry),
    });
    assert.equal(broadened.state, "blocked");
    assert.equal(broadened.blocker, "any_group_policy_boundary_unproven");

    const staleGateway = readActivationStatus({
      homeDirectory: temp.directory,
      command: new FakeCommand({ ...live, anyLocalGroupAuthorized: false, anyLocalGroupLive: false }, entry),
    });
    assert.equal(staleGateway.state, "restart-required");
    assert.equal(staleGateway.groupIngress.live, false);
  } finally {
    temp.cleanup();
  }
});

test("CLI accepts grants only from stdin and keeps install separate from enable", () => {
  const calls = [];
  const result = runCLI(["install", "--stdin-json", "--replace"], {
    readStdin: () => JSON.stringify({ fixture: true }),
    installActivation: (request, options) => {
      calls.push({ request, options });
      return { ok: true, state: "installed-disabled" };
    },
  });
  assert.equal(result.state, "installed-disabled");
  assert.deepEqual(calls, [{ request: { fixture: true }, options: { replace: true } }]);
  assert.throws(() => runCLI(["install"], { installActivation() {} }), /activation_request_stdin_required/u);
  assert.throws(() => runCLI(["install", "--stdin-json", "fixture-secret"], {}), /cli_flags_invalid/u);
});

test("signed-app packaging includes the any-local-group engine and reviewed adapter in both ISTS resource closures", () => {
  const packageScript = path.resolve(new URL("../../scripts/package-app.sh", import.meta.url).pathname);
  const source = fs.readFileSync(packageScript, "utf8");
  for (const relative of [
    "any-group-classifier.mjs",
    "any-group-contracts.mjs",
    "any-group-ingress.mjs",
    "any-group-source.mjs",
    "any-group-state-store.mjs",
    "imsg-executable.mjs",
    "adapters/any-local-group.mjs",
  ]) {
    const occurrences = source.split(relative).length - 1;
    assert.equal(occurrences, 2, `${relative} must be copied to both packaged ISTS closures`);
  }
  assert.equal(source.includes("Resources/RicoRecipientGuard/ISTSIncidentWorkflow/RicoEscalationHandoff"), true);
  assert.equal(source.includes("Resources/ISTSIncidentWorkflow/RicoEscalationHandoff"), true);
  for (const shared of ["handoff.js", "automatic-imt.mjs", "result-contract.js"]) {
    assert.equal(source.split(`RicoEscalationHandoff/${shared}`).length - 1 >= 3, true);
  }
});

test("shared native-config lease is private, exclusive, releasable, and recovers only a dead exact owner", () => {
  const temp = temporaryHome();
  try {
    const paths = defaultActivationPaths(temp.directory);
    const first = acquireNativeConfigLease({ supportDirectory: paths.configLeaseSupportDirectory, timeoutMs: 50, pollMs: 2 });
    const lockDirectory = path.join(paths.configLeaseSupportDirectory, "rico-native-config.lock");
    const ownerPath = path.join(lockDirectory, "owner.json");
    assert.equal(fs.lstatSync(lockDirectory).mode & 0o777, 0o700);
    assert.equal(fs.lstatSync(ownerPath).mode & 0o777, 0o600);
    assert.throws(
      () => acquireNativeConfigLease({ supportDirectory: paths.configLeaseSupportDirectory, timeoutMs: 15, pollMs: 2 }),
      /native_config_lease_busy/u,
    );
    assert.equal(first.release(), true);
    const replacement = acquireNativeConfigLease({ supportDirectory: paths.configLeaseSupportDirectory, timeoutMs: 50, pollMs: 2 });
    assert.equal(replacement.release(), true);

    fs.mkdirSync(lockDirectory, { mode: 0o700 });
    fs.writeFileSync(ownerPath, `${JSON.stringify({
      schema: "openclaw-studio-native-config-lease",
      schemaVersion: 1,
      pid: 2_000_000_000,
      token: "00000000-0000-4000-8000-000000000000",
    })}\n`, { mode: 0o600 });
    const recovered = acquireNativeConfigLease({ supportDirectory: paths.configLeaseSupportDirectory, timeoutMs: 50, pollMs: 2 });
    assert.equal(recovered.release(), true);
  } finally {
    temp.cleanup();
  }
});

test("shared native-config lease rejects symlinks and broadened owner metadata", () => {
  const temp = temporaryHome();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "rico-config-lock-outside-"));
  try {
    fs.chmodSync(outside, 0o700);
    const paths = defaultActivationPaths(temp.directory);
    fs.mkdirSync(paths.configLeaseSupportDirectory, { recursive: true, mode: 0o700 });
    const lockDirectory = path.join(paths.configLeaseSupportDirectory, "rico-native-config.lock");
    fs.symlinkSync(outside, lockDirectory);
    assert.throws(
      () => acquireNativeConfigLease({ supportDirectory: paths.configLeaseSupportDirectory, timeoutMs: 10, pollMs: 1 }),
      /native_config_lease_boundary_invalid/u,
    );
    fs.unlinkSync(lockDirectory);

    fs.mkdirSync(lockDirectory, { mode: 0o700 });
    fs.writeFileSync(path.join(lockDirectory, "owner.json"), `${JSON.stringify({
      schema: "openclaw-studio-native-config-lease",
      schemaVersion: 1,
      pid: process.pid,
      token: "00000000-0000-4000-8000-000000000000",
    })}\n`, { mode: 0o644 });
    assert.throws(
      () => acquireNativeConfigLease({ supportDirectory: paths.configLeaseSupportDirectory, timeoutMs: 10, pollMs: 1 }),
      /native_config_lease_boundary_invalid/u,
    );
  } finally {
    temp.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("ISTS config CAS retries from a fresh snapshot and preserves a concurrent unrelated update", () => {
  const temp = temporaryHome();
  try {
    const paths = defaultActivationPaths(temp.directory);
    const operations = [
      { path: "plugins.entries.rico-ists-incident.enabled", value: true },
      { path: "plugins.entries.rico-ists-incident.config", value: { enabled: false } },
    ];
    let dryRuns = 0;
    const command = {
      setBatch(values, { dryRun = false } = {}) {
        const current = JSON.parse(fs.readFileSync(paths.configPath, "utf8"));
        if (dryRun && dryRuns++ === 0) {
          current.concurrentWriter = { preserved: true };
          fs.writeFileSync(paths.configPath, `${JSON.stringify(current)}\n`, { mode: 0o600 });
          fs.chmodSync(paths.configPath, 0o600);
          return;
        }
        if (dryRun) return;
        for (const value of values) setPath(current, value.path, value.value);
        fs.writeFileSync(paths.configPath, `${JSON.stringify(current)}\n`, { mode: 0o600 });
        fs.chmodSync(paths.configPath, 0o600);
      },
      validateConfig() { return { valid: true }; },
    };
    const lease = acquireNativeConfigLease({ supportDirectory: paths.configLeaseSupportDirectory });
    try { applyConfigurationCAS(paths, command, operations); } finally { lease.release(); }
    const finalConfig = JSON.parse(fs.readFileSync(paths.configPath, "utf8"));
    assert.equal(dryRuns, 2);
    assert.equal(finalConfig.concurrentWriter.preserved, true);
    assert.equal(finalConfig.plugins.entries["rico-ists-incident"].enabled, true);
  } finally {
    temp.cleanup();
  }
});

test("lease busy timeout uses a monotonic clock and cannot be extended by wall-clock rollback", () => {
  const source = fs.readFileSync(new URL("../activation.mjs", import.meta.url), "utf8");
  const start = source.indexOf("export function acquireNativeConfigLease");
  const end = source.indexOf("export function validateActivationRequest", start);
  const leaseSource = source.slice(start, end);
  assert.equal(leaseSource.includes("performance.now()"), true);
  assert.equal(leaseSource.includes("Date.now()"), false);
});

function setPath(root, dottedPath, value) {
  const components = dottedPath.split(".");
  let cursor = root;
  for (const component of components.slice(0, -1)) {
    if (!cursor[component] || typeof cursor[component] !== "object" || Array.isArray(cursor[component])) cursor[component] = {};
    cursor = cursor[component];
  }
  cursor[components.at(-1)] = value;
}
