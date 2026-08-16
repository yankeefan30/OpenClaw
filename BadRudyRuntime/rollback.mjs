import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { atomicWritePrivateJson, assertPrivateFile, locations, readPrivateJson } from "./security.mjs";
import { codedError } from "./errors.mjs";

const execFile = promisify(execFileCallback);
export const OWNED_MANIFEST_SCHEMA = "openclaw.bad-rudy-owned-manifest/v1";
export const OWNERSHIP_MARKER = "openclaw-studio:bad-rudy";

export function validateOwnedManifest(input, homeDirectory = os.homedir()) {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.schema !== OWNED_MANIFEST_SCHEMA || input.schemaVersion !== 1) {
    throw codedError("rollback_manifest_invalid", "Bad Rudy's rollback manifest is invalid.");
  }
  const resolved = locations(homeDirectory);
  const allowedExact = new Set([
    resolved.stateRoot,
    resolved.launchAgentPath,
    resolved.installedRuntimeRoot,
    resolved.installedWorkerRoot,
  ].map((value) => path.resolve(value)));
  if (!Array.isArray(input.ownedPaths) || input.ownedPaths.length > 8) throw codedError("rollback_manifest_invalid", "Bad Rudy's rollback path list is invalid.");
  const ownedPaths = input.ownedPaths.map((entry) => {
    if (!entry || typeof entry !== "object" || !new Set(["file", "directory"]).has(entry.kind)) throw codedError("rollback_manifest_invalid", "A rollback path entry is invalid.");
    const target = path.resolve(String(entry.path ?? ""));
    if (!allowedExact.has(target)) throw codedError("rollback_path_unowned", "Bad Rudy refused to remove a path it does not exclusively own.");
    return Object.freeze({ path: target, kind: entry.kind, role: String(entry.role ?? "owned") });
  });
  if (!Array.isArray(input.configKeys) || input.configKeys.length > 4) throw codedError("rollback_manifest_invalid", "Bad Rudy's rollback config-key list is invalid.");
  const configKeys = input.configKeys.map((entry) => {
    const file = path.resolve(String(entry?.file ?? ""));
    if (file !== resolved.openClawConfigPath) throw codedError("rollback_config_unowned", "Bad Rudy refused to edit an unrelated config file.");
    if (!Array.isArray(entry.segments) || entry.segments.length < 1 || entry.segments.length > 8 ||
        entry.segments.some((segment) => !/^[a-zA-Z0-9._-]{1,80}$/u.test(String(segment)) || ["__proto__", "prototype", "constructor"].includes(String(segment)))) {
      throw codedError("rollback_manifest_invalid", "A rollback config key is invalid.");
    }
    return Object.freeze({ file, segments: entry.segments.map(String), ownershipMarker: String(entry.ownershipMarker ?? "") });
  });
  return Object.freeze({ schema: OWNED_MANIFEST_SCHEMA, schemaVersion: 1, ownedPaths, configKeys });
}

export function writeOwnedManifest(filePath, manifest, homeDirectory = os.homedir()) {
  const validated = validateOwnedManifest(manifest, homeDirectory);
  atomicWritePrivateJson(filePath, validated, { backup: fs.existsSync(filePath) });
  return validated;
}

export function planRollback({ homeDirectory = os.homedir(), manifestPath } = {}) {
  const resolved = locations(homeDirectory);
  const file = manifestPath ?? resolved.manifestPath;
  if (!fs.existsSync(file)) return Object.freeze({ installed: false, targets: [], configChanges: [] });
  assertPrivateFile(file);
  const manifest = validateOwnedManifest(readPrivateJson(file, null), homeDirectory);
  const targets = manifest.ownedPaths.filter((entry) => fs.existsSync(entry.path));
  for (const target of targets) inspectExactTarget(target);
  const configChanges = manifest.configKeys.filter((entry) => configKeyExistsAndOwned(entry));
  return Object.freeze({ installed: true, targets, configChanges, manifest });
}

export async function rollbackBadRudy({
  homeDirectory = os.homedir(),
  manifestPath,
  dryRun = false,
  execFileFn = execFile,
  now = () => new Date(),
} = {}) {
  const plan = planRollback({ homeDirectory, manifestPath });
  if (dryRun || !plan.installed) return Object.freeze({ ...plan, dryRun, movedTo: null });

  // Validate every target and config ownership before changing anything.
  for (const entry of plan.configChanges) assertConfigKeyOwned(entry);
  const timestamp = now().toISOString().replace(/[:.]/gu, "-");
  const trashParent = ensureRollbackTrashParent(homeDirectory);
  const trashRoot = path.join(trashParent, `OpenClaw-Bad-Rudy-Rollback-${timestamp}`);
  fs.mkdirSync(trashRoot, { recursive: false, mode: 0o700 });
  const launchAgent = plan.targets.find((entry) => entry.path === locations(homeDirectory).launchAgentPath);
  if (launchAgent) await unloadExactLaunchAgent(launchAgent.path, execFileFn);

  for (const entry of plan.configChanges) removeOwnedConfigKey(entry);

  const moved = [];
  for (const entry of plan.targets) {
    // Recheck immediately before the recoverable move.
    inspectExactTarget(entry);
    const destination = path.join(trashRoot, `${moved.length + 1}-${path.basename(entry.path)}`);
    fs.renameSync(entry.path, destination);
    moved.push({ from: entry.path, to: destination });
  }
  return Object.freeze({ installed: true, dryRun: false, movedTo: trashRoot, moved, configChanges: plan.configChanges });
}

function ensureRollbackTrashParent(homeDirectory) {
  const resolvedHome = path.resolve(homeDirectory);
  const trashParent = path.join(resolvedHome, ".Trash");
  if (!fs.existsSync(trashParent)) fs.mkdirSync(trashParent, { mode: 0o700 });
  const stat = fs.lstatSync(trashParent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw codedError("rollback_trash_unsafe", "Bad Rudy rollback refused an unsafe Trash directory.");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw codedError("rollback_trash_unowned", "Bad Rudy rollback refused a Trash directory with the wrong owner.");
  return trashParent;
}

function inspectExactTarget(entry) {
  const stat = fs.lstatSync(entry.path);
  if (stat.isSymbolicLink()) throw codedError("rollback_symlink_blocked", "Bad Rudy rollback refused a symbolic link.");
  if (entry.kind === "file" && !stat.isFile()) throw codedError("rollback_target_mismatch", "A Bad Rudy rollback file changed type.");
  if (entry.kind === "directory" && !stat.isDirectory()) throw codedError("rollback_target_mismatch", "A Bad Rudy rollback directory changed type.");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw codedError("rollback_target_unowned", "A Bad Rudy rollback target has the wrong owner.");
  if (stat.isDirectory()) inspectTreeNoLinks(entry.path, 0);
}

function inspectTreeNoLinks(directory, depth) {
  if (depth > 20) throw codedError("rollback_tree_too_deep", "Bad Rudy rollback refused an unexpectedly deep directory.");
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (entries.length > 10_000) throw codedError("rollback_tree_too_large", "Bad Rudy rollback refused an unexpectedly large directory.");
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    const stat = fs.lstatSync(child);
    if (stat.isSymbolicLink()) throw codedError("rollback_symlink_blocked", "Bad Rudy rollback refused a directory containing a symbolic link.");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw codedError("rollback_target_unowned", "A Bad Rudy rollback target has the wrong owner.");
    if (stat.isDirectory()) inspectTreeNoLinks(child, depth + 1);
  }
}

function configKeyExistsAndOwned(entry) {
  if (!fs.existsSync(entry.file)) return false;
  assertPrivateFile(entry.file);
  const value = readPrivateJson(entry.file, null);
  const target = valueAt(value, entry.segments);
  if (target === undefined) return false;
  assertOwnershipMarker(target, entry.ownershipMarker);
  return true;
}

function assertConfigKeyOwned(entry) {
  if (!configKeyExistsAndOwned(entry)) throw codedError("rollback_config_unowned", "Bad Rudy refused to remove a config key without its ownership marker.");
}

function removeOwnedConfigKey(entry) {
  const root = readPrivateJson(entry.file, null);
  const parent = valueAt(root, entry.segments.slice(0, -1));
  const key = entry.segments.at(-1);
  if (!parent || typeof parent !== "object" || Array.isArray(parent)) throw codedError("rollback_config_unowned", "Bad Rudy's owned config key is unavailable.");
  assertOwnershipMarker(parent[key], entry.ownershipMarker);
  delete parent[key];
  // This is the required timestamped pre-change backup for OpenClaw's config.
  atomicWritePrivateJson(entry.file, root, { backup: true });
}

function assertOwnershipMarker(value, marker) {
  if (!value || typeof value !== "object" || Array.isArray(value) || marker !== OWNERSHIP_MARKER || value._ownedBy !== marker) {
    throw codedError("rollback_config_unowned", "Bad Rudy refused to remove a config key without its exact ownership marker.");
  }
}

function valueAt(root, segments) {
  let value = root;
  for (const segment of segments) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, segment)) return undefined;
    value = value[segment];
  }
  return value;
}

async function unloadExactLaunchAgent(plistPath, execFileFn) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!Number.isInteger(uid)) throw codedError("rollback_launchagent_unavailable", "Bad Rudy could not determine the current launchd domain.");
  try {
    await execFileFn("/bin/launchctl", ["bootout", `gui/${uid}`, plistPath], { timeout: 10_000, env: { PATH: "/usr/bin:/bin" } });
  } catch (error) {
    // launchctl uses a nonzero exit when a valid plist is not currently loaded.
    // Treat only that narrow condition as already stopped; no stronger command
    // or broader domain operation is attempted.
    const detail = `${error?.stderr ?? ""} ${error?.message ?? ""}`;
    if (!/(?:could not find|no such process|not loaded|service cannot load)/iu.test(detail)) {
      throw codedError("rollback_launchagent_stop_failed", "Bad Rudy's scheduler could not be stopped safely; rollback made no file changes.", error);
    }
  }
}
