import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  assertPrivateFile,
  defaultGrantPath,
  ensurePrivateDirectory,
  installPrivateGrant,
  polarResearchAuthorized,
  readPrivateGrant,
  validatePermissionGrant,
  writePrivateJson,
} from "./grant.mjs";

export const ACTIVATION_SCHEMA = "rico.ists-incident-activation";
export const ACTIVATION_VERSION = 1;
export const NATIVE_CONFIG_LEASE_SCHEMA = "openclaw-studio-native-config-lease";
export const NATIVE_CONFIG_LEASE_VERSION = 1;

const REQUIRED_PLUGIN_FILES = Object.freeze([
  "index.js",
  "runtime.mjs",
  "definition.mjs",
  "grant.mjs",
  "contracts.mjs",
  "state-store.mjs",
  "engine.mjs",
  "context-provider.mjs",
  "audience-context.mjs",
  "imsg-executable.mjs",
  "any-group-classifier.mjs",
  "any-group-contracts.mjs",
  "any-group-ingress.mjs",
  "any-group-source.mjs",
  "any-group-state-store.mjs",
  "activation.mjs",
  "service.mjs",
  "status.mjs",
  "RicoEscalationHandoff/handoff.js",
  "RicoEscalationHandoff/automatic-imt.mjs",
  "RicoEscalationHandoff/result-contract.js",
  "openclaw.plugin.json",
  "package.json",
  "adapters/local-imessage.mjs",
  "adapters/any-local-group.mjs",
  "colleague-zone-adapter/index.mjs",
  "colleague-zone-adapter/browser-runtime.mjs",
  "colleague-zone-adapter/parser.mjs",
  "colleague-zone-adapter/selectors.mjs",
  "colleague-zone-adapter/scripts/reauth.mjs",
  "scripts/ists-incident.mjs",
]);

export function defaultActivationPaths(homeDirectory = os.homedir()) {
  const home = path.resolve(homeDirectory);
  const baseDirectory = path.join(home, "Library", "Application Support", "OpenClaw Studio", "workflows", "ists-incident");
  return Object.freeze({
    baseDirectory,
    grantPath: defaultGrantPath(home),
    stateDirectory: path.join(baseDirectory, "state"),
    adapterRuntimeDirectory: path.join(baseDirectory, "adapter-runtime"),
    mainAdapterPath: path.join(baseDirectory, "adapter-runtime", "adapters", "local-imessage.mjs"),
    anyGroupAdapterPath: path.join(baseDirectory, "adapter-runtime", "adapters", "any-local-group.mjs"),
    colleagueZoneAdapterPath: path.join(baseDirectory, "adapter-runtime", "colleague-zone-adapter", "index.mjs"),
    colleagueZoneReauthPath: path.join(baseDirectory, "adapter-runtime", "colleague-zone-adapter", "scripts", "reauth.mjs"),
    manifestPath: path.join(baseDirectory, "activation.json"),
    transactionPath: path.join(baseDirectory, "activation.transaction.json"),
    backupDirectory: path.join(baseDirectory, "backups"),
    configPath: path.join(home, ".openclaw", "openclaw.json"),
    configLeaseSupportDirectory: path.join(home, "Library", "Application Support", "OpenClaw Studio"),
  });
}

export function acquireNativeConfigLease({
  supportDirectory,
  timeoutMs = 10_000,
  pollMs = 50,
} = {}) {
  const root = ensurePrivateDirectory(path.resolve(supportDirectory ?? defaultActivationPaths().configLeaseSupportDirectory));
  const directory = path.join(root, "rico-native-config.lock");
  const ownerPath = path.join(directory, "owner.json");
  const deadline = performance.now() + timeoutMs;
  while (true) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
      fs.chmodSync(directory, 0o700);
      const directoryStat = requirePrivateDirectory(directory);
      const token = crypto.randomUUID().toLowerCase();
      const owner = {
        schema: NATIVE_CONFIG_LEASE_SCHEMA,
        schemaVersion: NATIVE_CONFIG_LEASE_VERSION,
        pid: process.pid,
        token,
      };
      try {
        writeExclusivePrivateJson(ownerPath, owner);
      } catch (error) {
        try { fs.unlinkSync(ownerPath); } catch {}
        try { fs.rmdirSync(directory); } catch {}
        throw error;
      }
      let owned = true;
      return Object.freeze({
        release() {
          if (!owned) return true;
          owned = false;
          const currentDirectory = requirePrivateDirectory(directory);
          const currentOwner = readLeaseOwner(ownerPath);
          if (currentDirectory.dev !== directoryStat.dev || currentDirectory.ino !== directoryStat.ino ||
              currentOwner.token !== token || currentOwner.pid !== process.pid) {
            throw coded("native_config_lease_release_mismatch");
          }
          fs.unlinkSync(ownerPath);
          fs.rmdirSync(directory);
          return true;
        },
      });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error?.code?.startsWith?.("native_config_lease_") ? error : coded("native_config_lease_unavailable", { cause: error });
      inspectOrRecoverNativeConfigLease(directory, ownerPath);
      if (performance.now() >= deadline) throw coded("native_config_lease_busy");
      synchronousDelay(pollMs);
    }
  }
}

export function validateActivationRequest(input) {
  exactKeys(input, ["schema", "schemaVersion", "permissionGrant", "colleagueZoneAdapterModule"], "activation request");
  if (input.schema !== "rico.ists-incident-activation-request" || input.schemaVersion !== 1) {
    throw coded("activation_request_schema_unsupported");
  }
  const grant = validatePermissionGrant(input.permissionGrant);
  if (grant.schemaVersion !== 2 || !grant.owner) {
    throw coded("activation_requires_scoped_grant_v2");
  }
  if (grant.imessage.anyLocalGroup && !polarResearchAuthorized(grant)) {
    throw coded("any_local_group_polar_not_authorized");
  }
  if (input.colleagueZoneAdapterModule !== null) {
    throw coded("colleague_zone_adapter_unexpected");
  }
  return Object.freeze({ permissionGrant: grant });
}

export function installActivation(input, options = {}) {
  const request = validateActivationRequest(input);
  const paths = Object.freeze({ ...defaultActivationPaths(options.homeDirectory), ...(options.paths ?? {}) });
  const pluginSourceDirectory = path.resolve(options.pluginSourceDirectory ?? path.dirname(fileURLToPath(import.meta.url)));
  const command = options.command ?? new OpenClawCommand(options.openclawPath);
  const replace = options.replace === true;
  ensurePrivateDirectory(paths.baseDirectory);
  ensurePrivateDirectory(paths.backupDirectory);
  if (fs.existsSync(paths.manifestPath) && !replace) throw coded("activation_already_installed");
  if (fs.existsSync(paths.transactionPath)) throw coded("activation_transaction_incomplete");
  const closure = verifyPluginClosure(pluginSourceDirectory);
  const transaction = {
    schema: ACTIVATION_SCHEMA,
    schemaVersion: ACTIVATION_VERSION,
    state: "installing",
    createdAt: new Date().toISOString(),
    configBackupPath: null,
    pluginClosureSha256: hashClosure(closure),
    permissionFile: paths.grantPath,
    stateDirectory: paths.stateDirectory,
    adapterModule: paths.mainAdapterPath,
    anyGroupAdapterModule: request.permissionGrant.imessage.anyLocalGroup
      ? paths.anyGroupAdapterPath
      : null,
    colleagueZoneAdapterModule: request.permissionGrant.colleagueZone.enabled
      ? paths.colleagueZoneAdapterPath
      : null,
  };
  writePrivateJson(paths.transactionPath, transaction);

  try {
    installAdapterRuntime(pluginSourceDirectory, paths.adapterRuntimeDirectory, {
      replace,
      includeAnyGroup: request.permissionGrant.imessage.anyLocalGroup,
    });
    installPrivateGrant(request.permissionGrant, { filePath: paths.grantPath, replace });
    ensurePrivateDirectory(paths.stateDirectory);
    withNativeConfigTransaction(paths, command, "install", ({ backup }) => {
      transaction.configBackupPath = backup;
      writePrivateJson(paths.transactionPath, transaction, { backup: true });
      command.run(["plugins", "install", pluginSourceDirectory, ...(replace ? ["--force"] : [])]);
      applyConfigurationCAS(paths, command, configurationOperations(transaction, false));
    });
    transaction.state = "installed-disabled";
    transaction.installedAt = new Date().toISOString();
    writePrivateJson(paths.manifestPath, transaction, { backup: replace && fs.existsSync(paths.manifestPath) });
    fs.unlinkSync(paths.transactionPath);
    return safeInstallResult(transaction);
  } catch (error) {
    transaction.state = "install-failed";
    transaction.errorCode = safeCode(error);
    try { writePrivateJson(paths.transactionPath, transaction, { backup: true }); } catch {}
    throw coded("activation_install_failed", { cause: error });
  }
}

export function enableActivation(options = {}) {
  const paths = Object.freeze({ ...defaultActivationPaths(options.homeDirectory), ...(options.paths ?? {}) });
  const command = options.command ?? new OpenClawCommand(options.openclawPath);
  const manifest = readManifest(paths.manifestPath);
  const grant = readPrivateGrant(manifest.permissionFile);
  if (grant.schemaVersion !== 2 || !grant.owner) throw coded("activation_requires_scoped_grant_v2");
  if (grant.imessage.anyLocalGroup && !polarResearchAuthorized(grant)) {
    throw coded("any_local_group_polar_not_authorized");
  }
  assertPrivateFile(manifest.adapterModule);
  if (grant.imessage.anyLocalGroup) {
    if (!manifest.anyGroupAdapterModule) throw coded("any_group_adapter_missing");
    assertPrivateFile(manifest.anyGroupAdapterModule);
  } else if (manifest.anyGroupAdapterModule) {
    throw coded("any_group_adapter_unexpected");
  }
  if (grant.colleagueZone.enabled) {
    if (!manifest.colleagueZoneAdapterModule) throw coded("colleague_zone_adapter_missing");
    assertPrivateFile(manifest.colleagueZoneAdapterModule);
  } else if (manifest.colleagueZoneAdapterModule) {
    throw coded("colleague_zone_adapter_unexpected");
  }
  try {
    withNativeConfigTransaction(paths, command, "enable", ({ backup }) => {
      applyConfigurationCAS(paths, command, configurationOperations(manifest, true));
      manifest.state = "configured-enabled-restart-required";
      manifest.enabledAt = new Date().toISOString();
      manifest.lastConfigBackupPath = backup;
      writePrivateJson(paths.manifestPath, manifest, { backup: true });
    });
    if (options.restartGateway === true) {
      command.run(["gateway", "restart"]);
      manifest.state = "enabled-restart-requested";
      manifest.restartRequestedAt = new Date().toISOString();
      writePrivateJson(paths.manifestPath, manifest, { backup: true });
    }
    return safeInstallResult(manifest);
  } catch (error) {
    throw coded("activation_enable_failed", { cause: error });
  }
}

export function disableActivation(options = {}) {
  const paths = Object.freeze({ ...defaultActivationPaths(options.homeDirectory), ...(options.paths ?? {}) });
  const command = options.command ?? new OpenClawCommand(options.openclawPath);
  const manifest = readManifest(paths.manifestPath);
  try {
    withNativeConfigTransaction(paths, command, "disable", ({ backup }) => {
      applyConfigurationCAS(paths, command, configurationOperations(manifest, false));
      manifest.state = "configured-disabled-restart-required";
      manifest.disabledAt = new Date().toISOString();
      manifest.lastConfigBackupPath = backup;
      writePrivateJson(paths.manifestPath, manifest, { backup: true });
    });
    if (options.restartGateway === true) {
      command.run(["gateway", "restart"]);
      manifest.state = "disabled-restart-requested";
      manifest.restartRequestedAt = new Date().toISOString();
      writePrivateJson(paths.manifestPath, manifest, { backup: true });
    }
    return safeInstallResult(manifest);
  } catch (error) {
    throw coded("activation_disable_failed", { cause: error });
  }
}

export class OpenClawCommand {
  constructor(executable = undefined) {
    this.executable = executable ? path.resolve(executable) : findOpenClaw();
  }

  run(argv) {
    const result = spawnSync(this.executable, argv, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
      env: { ...process.env, PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" },
    });
    if (result.error || result.status !== 0) throw coded("openclaw_command_failed");
    return String(result.stdout ?? "").trim();
  }

  setBatch(operations, { dryRun = false } = {}) {
    const argv = ["config", "set", "--batch-json", JSON.stringify(operations)];
    if (dryRun) argv.push("--dry-run");
    return this.run(argv);
  }

  validateConfig() {
    const output = this.run(["config", "validate", "--json"]);
    const value = JSON.parse(output);
    if (value?.valid === false) throw coded("openclaw_config_invalid");
    return value;
  }
}

export function verifyPluginClosure(pluginSourceDirectory) {
  const root = path.resolve(pluginSourceDirectory);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw coded("plugin_source_invalid");
  return Object.freeze(REQUIRED_PLUGIN_FILES.map((relative) => {
    const filePath = path.join(root, relative);
    const file = fs.lstatSync(filePath);
    if (!file.isFile() || file.isSymbolicLink()) throw coded("plugin_closure_incomplete");
    return Object.freeze({ relative, sha256: sha256(fs.readFileSync(filePath)) });
  }));
}

function installAdapterRuntime(pluginSourceDirectory, destinationDirectory, { replace, includeAnyGroup }) {
  const root = ensurePrivateDirectory(destinationDirectory);
  const adapterDirectory = ensurePrivateDirectory(path.join(root, "adapters"));
  const colleagueZoneDirectory = ensurePrivateDirectory(path.join(root, "colleague-zone-adapter"));
  const colleagueZoneScriptsDirectory = ensurePrivateDirectory(path.join(colleagueZoneDirectory, "scripts"));
  copyPrivateFile(path.join(pluginSourceDirectory, "grant.mjs"), path.join(root, "grant.mjs"), { replace });
  copyPrivateFile(path.join(pluginSourceDirectory, "definition.mjs"), path.join(root, "definition.mjs"), { replace });
  copyPrivateFile(path.join(pluginSourceDirectory, "imsg-executable.mjs"), path.join(root, "imsg-executable.mjs"), { replace });
  copyPrivateFile(
    path.join(pluginSourceDirectory, "adapters", "local-imessage.mjs"),
    path.join(adapterDirectory, "local-imessage.mjs"),
    { replace },
  );
  if (includeAnyGroup === true) {
    const handoffDirectory = ensurePrivateDirectory(path.join(root, "RicoEscalationHandoff"));
    for (const relative of ["contracts.mjs", "any-group-contracts.mjs", "any-group-source.mjs"]) {
      copyPrivateFile(path.join(pluginSourceDirectory, relative), path.join(root, relative), { replace });
    }
    copyPrivateFile(
      path.join(pluginSourceDirectory, "RicoEscalationHandoff", "result-contract.js"),
      path.join(handoffDirectory, "result-contract.js"),
      { replace },
    );
    copyPrivateFile(
      path.join(pluginSourceDirectory, "adapters", "any-local-group.mjs"),
      path.join(adapterDirectory, "any-local-group.mjs"),
      { replace },
    );
  }
  for (const relative of ["index.mjs", "browser-runtime.mjs", "parser.mjs", "selectors.mjs"]) {
    copyPrivateFile(
      path.join(pluginSourceDirectory, "colleague-zone-adapter", relative),
      path.join(colleagueZoneDirectory, relative),
      { replace },
    );
  }
  copyPrivateFile(
    path.join(pluginSourceDirectory, "colleague-zone-adapter", "scripts", "reauth.mjs"),
    path.join(colleagueZoneScriptsDirectory, "reauth.mjs"),
    { replace },
  );
}

function copyPrivateFile(source, destination, { replace }) {
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw coded("adapter_source_invalid");
  if (fs.existsSync(destination)) {
    assertPrivateFile(destination);
    if (!replace) {
      if (sha256(fs.readFileSync(source)) === sha256(fs.readFileSync(destination))) return;
      throw coded("adapter_runtime_exists");
    }
    const backup = `${destination}.backup.${Date.now()}`;
    fs.copyFileSync(destination, backup, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backup, 0o600);
  }
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, fs.readFileSync(source));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, destination);
  fs.chmodSync(destination, 0o600);
}

function configurationOperations(manifest, enabled) {
  const config = {
    enabled,
    anyGroupEnabled: enabled && Boolean(manifest.anyGroupAdapterModule),
    adapterModule: manifest.adapterModule,
    permissionFile: manifest.permissionFile,
    stateDirectory: manifest.stateDirectory,
    ...(manifest.anyGroupAdapterModule ? { anyGroupAdapterModule: manifest.anyGroupAdapterModule } : {}),
    ...(manifest.colleagueZoneAdapterModule ? { colleagueZoneAdapterModule: manifest.colleagueZoneAdapterModule } : {}),
  };
  return [
    { path: "plugins.entries.rico-ists-incident.enabled", value: true },
    { path: "plugins.entries.rico-ists-incident.config", value: config },
  ];
}

function withNativeConfigTransaction(paths, command, action, operation) {
  const lease = acquireNativeConfigLease({ supportDirectory: paths.configLeaseSupportDirectory });
  let backup;
  try {
    backup = backupConfig(paths.configPath, paths.backupDirectory, action);
    const result = operation({ backup });
    lease.release();
    return result;
  } catch (error) {
    if (backup) {
      try { restoreConfig(paths.configPath, backup); } catch {}
    }
    try { lease.release(); } catch {}
    throw error;
  }
}

export function applyConfigurationCAS(paths, command, operations) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const baseline = readPrivateConfigSnapshot(paths.configPath);
    command.setBatch(operations, { dryRun: true });
    const afterDryRun = readPrivateConfigSnapshot(paths.configPath);
    if (afterDryRun.sha256 !== baseline.sha256) continue;
    command.setBatch(operations);
    command.validateConfig();
    if (command instanceof OpenClawCommand) {
      const verified = readPrivateConfigSnapshot(paths.configPath);
      if (!operationsMatchConfig(operations, verified.value)) throw coded("openclaw_config_readback_mismatch");
    }
    return;
  }
  throw coded("openclaw_config_changed_during_transaction");
}

function readPrivateConfigSnapshot(configPath) {
  const resolved = path.resolve(configPath);
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const descriptor = fs.openSync(resolved, flags);
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid() ||
        (before.mode & 0o777) !== 0o600 || before.size <= 0 || before.size > 16 * 1024 * 1024) {
      throw coded("openclaw_config_unavailable");
    }
    const data = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || data.length !== after.size) {
      throw coded("openclaw_config_changed_during_read");
    }
    return Object.freeze({ value: JSON.parse(data.toString("utf8")), sha256: sha256(data) });
  } finally {
    fs.closeSync(descriptor);
  }
}

function operationsMatchConfig(operations, value) {
  return operations.every((operation) => {
    let cursor = value;
    for (const component of String(operation.path).split(".")) {
      if (!cursor || typeof cursor !== "object" || Array.isArray(cursor) || !(component in cursor)) return false;
      cursor = cursor[component];
    }
    return JSON.stringify(cursor) === JSON.stringify(operation.value);
  });
}

function requirePrivateDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) {
    throw coded("native_config_lease_boundary_invalid");
  }
  return stat;
}

function writeExclusivePrivateJson(filePath, value) {
  const descriptor = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(descriptor);
    fs.fchmodSync(descriptor, 0o600);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) {
      throw coded("native_config_lease_boundary_invalid");
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function readLeaseOwner(ownerPath) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const descriptor = fs.openSync(ownerPath, flags);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() ||
        (stat.mode & 0o777) !== 0o600 || stat.size <= 0 || stat.size > 4096) {
      throw coded("native_config_lease_boundary_invalid");
    }
    const owner = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    if (owner?.schema !== NATIVE_CONFIG_LEASE_SCHEMA || owner.schemaVersion !== NATIVE_CONFIG_LEASE_VERSION ||
        Object.keys(owner).sort().join(",") !== "pid,schema,schemaVersion,token" ||
        !Number.isSafeInteger(owner.pid) || owner.pid <= 1 ||
        typeof owner.token !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(owner.token)) {
      throw coded("native_config_lease_boundary_invalid");
    }
    return owner;
  } finally {
    fs.closeSync(descriptor);
  }
}

function inspectOrRecoverNativeConfigLease(directory, ownerPath) {
  const directoryStat = requirePrivateDirectory(directory);
  const owner = readLeaseOwner(ownerPath);
  try {
    process.kill(owner.pid, 0);
    return;
  } catch (error) {
    if (error?.code !== "ESRCH") return;
  }
  const recheck = requirePrivateDirectory(directory);
  const recheckedOwner = readLeaseOwner(ownerPath);
  if (recheck.dev !== directoryStat.dev || recheck.ino !== directoryStat.ino ||
      recheckedOwner.pid !== owner.pid || recheckedOwner.token !== owner.token) {
    throw coded("native_config_lease_boundary_invalid");
  }
  fs.unlinkSync(ownerPath);
  fs.rmdirSync(directory);
}

function synchronousDelay(milliseconds) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, Math.max(1, milliseconds));
}

function backupConfig(configPath, backupDirectory, action) {
  const source = path.resolve(configPath);
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw coded("openclaw_config_unavailable");
  ensurePrivateDirectory(backupDirectory);
  const target = path.join(backupDirectory, `openclaw.${action}.${timestamp()}.json`);
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(target, 0o600);
  return target;
}

function restoreConfig(configPath, backupPath) {
  assertPrivateFile(backupPath);
  const target = path.resolve(configPath);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.copyFileSync(backupPath, temporary, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, target);
}

function readManifest(filePath) {
  assertPrivateFile(filePath);
  const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (value?.schema !== ACTIVATION_SCHEMA || value.schemaVersion !== ACTIVATION_VERSION) throw coded("activation_manifest_invalid");
  return value;
}

function safeInstallResult(manifest) {
  const anyLocalGroupInstalled = Boolean(manifest.anyGroupAdapterModule);
  return Object.freeze({
    ok: true,
    state: manifest.state,
    monitoringEnabled: new Set(["configured-enabled-restart-required", "enabled-restart-requested"]).has(manifest.state),
    exactScope: anyLocalGroupInstalled
      ? "owner+jeff+incident-source+any-local-group-ists-only"
      : "owner+jeff+incident-query-groups",
    groupIngress: anyLocalGroupInstalled
      ? "dedicated-ists-only-any-local-group"
      : "recipient-guard-reviewed-groups-only",
    anyLocalGroupInstalled,
    anyLocalGroupAuthorized: anyLocalGroupInstalled,
    generalRicoPolicyBroadened: false,
    nativeAllowlistBroadened: false,
    grantSchemaVersion: 2,
    restartRequired: manifest.state.includes("restart-required"),
  });
}

function hashClosure(closure) {
  return sha256(JSON.stringify(closure));
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

function findOpenClaw() {
  for (const candidate of ["/opt/homebrew/bin/openclaw", "/usr/local/bin/openclaw"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw coded("openclaw_unavailable");
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw coded(`${slug(label)}_invalid`);
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) throw coded(`${slug(label)}_fields_invalid`);
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_|_$/gu, "");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeCode(error) {
  return String(error?.code ?? error?.name ?? "unknown").toLowerCase().replace(/[^a-z0-9_-]+/gu, "_").slice(0, 80) || "unknown";
}

function coded(code, options = undefined) {
  const error = new Error(code, options);
  error.code = code;
  return error;
}
