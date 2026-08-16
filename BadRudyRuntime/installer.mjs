import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BadRudyConfigStore, defaultConfig } from "./config.mjs";
import { codedError } from "./errors.mjs";
import { OWNED_MANIFEST_SCHEMA, OWNERSHIP_MARKER, validateOwnedManifest, writeOwnedManifest } from "./rollback.mjs";
import { atomicWritePrivateJson, ensurePrivateDirectory, ensurePrivateDirectoryChain, locations, readPrivateJson } from "./security.mjs";

export const FEATURE_MARKER_SCHEMA = "openclaw.bad-rudy-feature/v1";
export const BUNDLED_RUNTIME_DIRECTORY = "BadRudyRuntime";
export const BUNDLED_WORKER_DIRECTORY = "GrokCompanionsWorker";

export const BUNDLED_RUNTIME_FILES = Object.freeze([
  "README.md",
  "captured-clip.mjs",
  "config.mjs",
  "delivery.mjs",
  "errors.mjs",
  "events.mjs",
  "gates.mjs",
  "index.mjs",
  "installer.mjs",
  "keychain.mjs",
  "package.json",
  "prompt.mjs",
  "rollback.mjs",
  "runtime.mjs",
  "scheduler.mjs",
  "security.mjs",
  "status.mjs",
  "stores.mjs",
  "worker-client.mjs",
  "scripts/bad-rudy.mjs",
]);

export const BUNDLED_WORKER_FILES = Object.freeze([
  "README.md",
  "index.ts",
  "package.json",
  "selectors.ts",
  "tsconfig.json",
]);

export function featureMarker() {
  return Object.freeze({
    schema: FEATURE_MARKER_SCHEMA,
    schemaVersion: 1,
    _ownedBy: OWNERSHIP_MARKER,
  });
}

export function validateFeatureMarker(value) {
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
  if (keys.join("\u0000") !== ["_ownedBy", "schema", "schemaVersion"].sort().join("\u0000") ||
      value.schema !== FEATURE_MARKER_SCHEMA || value.schemaVersion !== 1 || value._ownedBy !== OWNERSHIP_MARKER) {
    throw codedError("feature_marker_invalid", "Bad Rudy's private feature marker is invalid.");
  }
  return Object.freeze({ ...value });
}

/**
 * Resolves the production source only from:
 *   OpenClaw Studio.app/Contents/Resources/BadRudyRuntime/scripts/bad-rudy.mjs
 * No repository, cwd, PATH, environment, or candidate search is accepted.
 */
export function bundledResourcesRootFromScript(scriptURL) {
  const scriptPath = path.resolve(fileURLToPath(scriptURL));
  const resourcesRoot = path.resolve(path.dirname(scriptPath), "..", "..");
  assertProductionResourcesRoot(resourcesRoot);
  return resourcesRoot;
}

export function installPlan({ homeDirectory, resourcesRoot, testOnlyAllowUnbundledResources = false }) {
  const target = locations(homeDirectory);
  const sourceRoot = path.resolve(resourcesRoot);
  if (!testOnlyAllowUnbundledResources) assertProductionResourcesRoot(sourceRoot);
  const runtimeSource = path.join(sourceRoot, BUNDLED_RUNTIME_DIRECTORY);
  const workerSource = path.join(sourceRoot, BUNDLED_WORKER_DIRECTORY);
  validateSourceFiles(runtimeSource, BUNDLED_RUNTIME_FILES);
  validateSourceFiles(workerSource, BUNDLED_WORKER_FILES);
  assessExistingOwnership(target);
  return Object.freeze({
    resourcesRoot: sourceRoot,
    runtimeSource,
    workerSource,
    runtimeDestination: target.installedRuntimeRoot,
    workerDestination: target.installedWorkerRoot,
    featureMarkerPath: target.featureMarkerPath,
    configPath: target.configPath,
    manifestPath: target.manifestPath,
  });
}

export function installBadRudy({
  homeDirectory,
  resourcesRoot,
  testOnlyAllowUnbundledResources = false,
  now = () => new Date(),
} = {}) {
  const target = locations(homeDirectory);
  const plan = installPlan({ homeDirectory, resourcesRoot, testOnlyAllowUnbundledResources });
  const runtimeParent = ensurePrivateDirectoryChain(target.home, path.dirname(target.installedRuntimeRoot));
  const workerParent = ensurePrivateDirectoryChain(target.home, path.dirname(target.installedWorkerRoot));
  ensurePrivateDirectoryChain(target.home, target.stateRoot);
  const { createdConfig } = ensureInstallState(target, homeDirectory);

  const transactionId = crypto.randomUUID();
  const runtimeStage = path.join(runtimeParent, `.bad-rudy.install-${transactionId}`);
  const workerStage = path.join(workerParent, `.grok-companions.install-${transactionId}`);
  try {
    copyAllowlistedTree(plan.runtimeSource, runtimeStage, BUNDLED_RUNTIME_FILES);
    atomicWritePrivateJson(path.join(runtimeStage, "feature.json"), featureMarker());
    copyAllowlistedTree(plan.workerSource, workerStage, BUNDLED_WORKER_FILES);
  } catch (error) {
    moveFailedStage(runtimeStage, target, now, "runtime-stage");
    moveFailedStage(workerStage, target, now, "worker-stage");
    throw error;
  }

  const timestamp = timestampComponent(now());
  const existingRuntime = fs.existsSync(target.installedRuntimeRoot);
  const existingWorker = fs.existsSync(target.installedWorkerRoot);
  const backupRoot = existingRuntime || existingWorker
    ? createUniqueBackupRoot(target.stateRoot, timestamp)
    : null;
  const movedBackups = [];
  const installed = [];
  try {
    if (existingRuntime) movedBackups.push(moveOwnedCodeToBackup(target.installedRuntimeRoot, backupRoot, "bad-rudy"));
    if (existingWorker) movedBackups.push(moveOwnedCodeToBackup(target.installedWorkerRoot, backupRoot, "grok-companions"));
    fs.renameSync(runtimeStage, target.installedRuntimeRoot);
    installed.push(target.installedRuntimeRoot);
    fs.renameSync(workerStage, target.installedWorkerRoot);
    installed.push(target.installedWorkerRoot);
  } catch (error) {
    recoverFailedCommit({ installed, movedBackups, runtimeStage, workerStage, target, now });
    throw codedError("install_commit_failed", "Bad Rudy installation could not be committed; prior owned code was restored when possible.", error);
  }

  return Object.freeze({
    installed: true,
    offline: true,
    runtimePath: target.installedRuntimeRoot,
    workerPath: target.installedWorkerRoot,
    featureMarkerPath: target.featureMarkerPath,
    configPath: target.configPath,
    manifestPath: target.manifestPath,
    createdMarker: !existingRuntime,
    createdConfig,
    backupPath: backupRoot,
    launchAgentInstalled: false,
    openClawConfigChanged: false,
  });
}

function ensureInstallState(target, homeDirectory) {
  const configStore = new BadRudyConfigStore(target.configPath, { privateAnchor: target.home });
  let createdConfig = false;
  if (configStore.exists()) {
    configStore.read();
  } else {
    configStore.write(defaultConfig());
    createdConfig = true;
  }

  const manifest = {
    schema: OWNED_MANIFEST_SCHEMA,
    schemaVersion: 1,
    ownedPaths: [
      { path: target.installedRuntimeRoot, kind: "directory", role: "runtime-module" },
      { path: target.installedWorkerRoot, kind: "directory", role: "playwright-worker" },
      // State is last so rollback can move installed code first and retain its
      // manifest/backups until the final recoverable move.
      { path: target.stateRoot, kind: "directory", role: "private-state" },
    ],
    configKeys: [],
  };
  writeOwnedManifest(target.manifestPath, manifest, homeDirectory);
  return { createdConfig };
}

function assertProductionResourcesRoot(resourcesRoot) {
  const normalized = path.resolve(resourcesRoot);
  const suffix = `${path.sep}OpenClaw Studio.app${path.sep}Contents${path.sep}Resources`;
  if (!normalized.endsWith(suffix)) throw codedError("bundle_resources_required", "Install Bad Rudy only from OpenClaw Studio.app's bundled Resources directory.");
  const appRoot = normalized.slice(0, -`${path.sep}Contents${path.sep}Resources`.length);
  for (const component of [appRoot, path.join(appRoot, "Contents"), normalized]) {
    const stat = fs.lstatSync(component);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw codedError("bundle_resources_unsafe", "OpenClaw Studio's bundled Resources directory is unsafe.");
  }
}

function validateSourceFiles(sourceRoot, fileList) {
  const root = path.resolve(sourceRoot);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw codedError("bundle_source_unsafe", "A bundled Bad Rudy source directory is unsafe.");
  for (const relative of fileList) {
    if (!validRelativeFile(relative)) throw codedError("bundle_manifest_invalid", "Bad Rudy's bundled file manifest is invalid.");
    const source = path.join(root, relative);
    const resolved = path.resolve(source);
    if (!resolved.startsWith(`${root}${path.sep}`)) throw codedError("bundle_source_unsafe", "A bundled Bad Rudy file escaped its source directory.");
    assertNoLinkedComponents(root, relative);
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw codedError("bundle_source_unsafe", "A required bundled Bad Rudy file is unsafe or missing.");
  }
}

function copyAllowlistedTree(sourceRoot, destinationRoot, fileList) {
  if (fs.existsSync(destinationRoot)) throw codedError("install_stage_exists", "Bad Rudy's private install staging path already exists.");
  fs.mkdirSync(destinationRoot, { mode: 0o700 });
  for (const relative of fileList) {
    const source = path.join(sourceRoot, relative);
    const destination = path.join(destinationRoot, relative);
    ensurePrivateSubdirectory(destinationRoot, path.dirname(destination));
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, 0o600);
  }
}

function assessExistingOwnership(target) {
  const existingCode = [target.installedRuntimeRoot, target.installedWorkerRoot].filter((candidate) => fs.existsSync(candidate));
  const stateExists = fs.existsSync(target.stateRoot);
  if (stateExists) {
    const stat = fs.lstatSync(target.stateRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) {
      throw codedError("existing_install_unowned", "Existing Bad Rudy state is not a private owned directory.");
    }
  }
  if (existingCode.length === 0 && !stateExists) return;
  if (existingCode.length === 0) {
    if (fs.readdirSync(target.stateRoot).length === 0) return;
    // A failed first install can leave a valid owned manifest/config but no
    // visible feature module. That state is safe to resume.
    if (fs.existsSync(target.manifestPath)) {
      validateOwnedManifest(readPrivateJson(target.manifestPath, null), target.home);
      return;
    }
    throw codedError("existing_install_unowned", "Bad Rudy refused to claim nonempty state without its exact owned manifest.");
  }
  if (!fs.existsSync(target.installedRuntimeRoot) || !fs.existsSync(target.featureMarkerPath) || !fs.existsSync(target.manifestPath)) {
    throw codedError("existing_install_unowned", "Bad Rudy refused to replace existing code without its exact module marker and private manifest.");
  }
  validateFeatureMarker(readPrivateJson(target.featureMarkerPath, null));
  const manifest = validateOwnedManifest(readPrivateJson(target.manifestPath, null), target.home);
  const owned = new Set(manifest.ownedPaths.map((entry) => entry.path));
  for (const destination of existingCode) {
    if (!owned.has(destination)) throw codedError("existing_install_unowned", "Bad Rudy refused to replace a path absent from its owned manifest.");
    assertInstalledDirectory(destination);
  }
}

function assertInstalledDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw codedError("existing_install_unsafe", "Existing Bad Rudy code is not a safe directory.");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw codedError("existing_install_unowned", "Existing Bad Rudy code has the wrong owner.");
  inspectNoLinks(directory, 0);
}

function inspectNoLinks(directory, depth) {
  if (depth > 20) throw codedError("existing_install_unsafe", "Existing Bad Rudy code is unexpectedly deep.");
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (entries.length > 10_000) throw codedError("existing_install_unsafe", "Existing Bad Rudy code is unexpectedly large.");
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    const stat = fs.lstatSync(child);
    if (stat.isSymbolicLink()) throw codedError("existing_install_unsafe", "Existing Bad Rudy code contains a symbolic link.");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw codedError("existing_install_unowned", "Existing Bad Rudy code has the wrong owner.");
    if (stat.isDirectory()) inspectNoLinks(child, depth + 1);
  }
}

function moveOwnedCodeToBackup(source, backupRoot, name) {
  assertInstalledDirectory(source);
  const destination = path.join(backupRoot, name);
  fs.renameSync(source, destination);
  return { source, destination };
}

function recoverFailedCommit({ installed, movedBackups, runtimeStage, workerStage, target, now }) {
  const failedRoot = createUniqueBackupRoot(target.stateRoot, `${timestampComponent(now())}-failed`);
  for (const installedPath of installed.reverse()) {
    if (fs.existsSync(installedPath)) fs.renameSync(installedPath, path.join(failedRoot, `new-${path.basename(installedPath)}`));
  }
  for (const backup of movedBackups.reverse()) {
    if (!fs.existsSync(backup.source) && fs.existsSync(backup.destination)) fs.renameSync(backup.destination, backup.source);
  }
  if (fs.existsSync(runtimeStage)) fs.renameSync(runtimeStage, path.join(failedRoot, "runtime-stage"));
  if (fs.existsSync(workerStage)) fs.renameSync(workerStage, path.join(failedRoot, "worker-stage"));
}

function moveFailedStage(stage, target, now, name) {
  if (!fs.existsSync(stage)) return;
  ensurePrivateDirectory(target.stateRoot);
  const failedRoot = createUniqueBackupRoot(target.stateRoot, `${timestampComponent(now())}-failed`);
  fs.renameSync(stage, path.join(failedRoot, name));
}

function createUniqueBackupRoot(stateRoot, timestamp) {
  const backupsRoot = path.join(stateRoot, "backups");
  ensurePrivateDirectory(backupsRoot);
  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? "" : `-${index}`;
    const candidate = path.join(backupsRoot, `${timestamp}${suffix}`);
    try {
      fs.mkdirSync(candidate, { mode: 0o700 });
      return candidate;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw codedError("backup_path_unavailable", "Bad Rudy could not allocate a private timestamped backup directory.");
}

function ensurePrivateSubdirectory(root, directory) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(directory);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw codedError("install_path_unsafe", "A Bad Rudy install path escaped its staging directory.");
  if (resolved === resolvedRoot) return;
  const relative = path.relative(resolvedRoot, resolved);
  let current = resolvedRoot;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw codedError("install_path_unsafe", "A Bad Rudy install subdirectory is unsafe.");
  }
}

function assertNoLinkedComponents(root, relative) {
  let current = path.resolve(root);
  const components = relative.split("/").slice(0, -1);
  for (const component of components) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw codedError("bundle_source_unsafe", "A bundled Bad Rudy source component is unsafe.");
  }
}

function validRelativeFile(value) {
  return typeof value === "string" && value.length > 0 && !path.isAbsolute(value) &&
    !value.includes("\\") && value.split("/").every((component) => component && component !== "." && component !== "..");
}

function timestampComponent(date) {
  const timestamp = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(timestamp.getTime())) throw codedError("clock_invalid", "Bad Rudy could not create a timestamped backup.");
  return timestamp.toISOString().replace(/[:.]/gu, "-");
}
