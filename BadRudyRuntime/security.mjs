import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codedError } from "./errors.mjs";

export const RUNTIME_SCHEMA = "openclaw.bad-rudy-runtime/v1";

export function locations(homeDirectory = os.homedir()) {
  const home = path.resolve(homeDirectory);
  const artifactRoot = path.join(home, "OpenClaw", "artifacts", "bad-rudy");
  const stateRoot = path.join(artifactRoot, "_state");
  const installedRuntimeRoot = path.join(home, "Library", "Application Support", "OpenClaw Studio", "modules", "bad-rudy");
  return Object.freeze({
    home,
    artifactRoot,
    stateRoot,
    configPath: path.join(stateRoot, "config.json"),
    eventsPath: path.join(stateRoot, "events.jsonl"),
    capturesPath: path.join(stateRoot, "captures.json"),
    confirmationPath: path.join(stateRoot, "confirmations.json"),
    queuePath: path.join(stateRoot, "schedule.json"),
    dedupePath: path.join(stateRoot, "dedupe.json"),
    ratePath: path.join(stateRoot, "rate.json"),
    manifestPath: path.join(stateRoot, "owned-manifest.json"),
    launchAgentPath: path.join(home, "Library", "LaunchAgents", "ai.openclaw.bad-rudy-scheduler.plist"),
    openClawConfigPath: path.join(home, ".openclaw", "openclaw.json"),
    installedRuntimeRoot,
    featureMarkerPath: path.join(installedRuntimeRoot, "feature.json"),
    installedWorkerRoot: path.join(home, "OpenClaw", "workers", "grok-companions"),
  });
}

export function ensurePrivateDirectory(directory) {
  const resolved = path.resolve(directory);
  const existed = fs.existsSync(resolved);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw codedError("unsafe_state_directory", "Bad Rudy's private state directory is unsafe.");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw codedError("wrong_state_owner", "Bad Rudy's private state directory has the wrong owner.");
  if ((stat.mode & 0o777) !== 0o700) {
    if (existed) throw codedError("unsafe_state_permissions", "Bad Rudy's existing state directory must use mode 0700.");
    fs.chmodSync(resolved, 0o700);
  }
  return resolved;
}

export function ensurePrivateDirectoryChain(anchor, directory) {
  const resolvedAnchor = path.resolve(anchor);
  const resolvedDirectory = path.resolve(directory);
  if (resolvedDirectory !== resolvedAnchor && !resolvedDirectory.startsWith(`${resolvedAnchor}${path.sep}`)) {
    throw codedError("unsafe_state_directory", "Bad Rudy refused a private directory outside its owned root.");
  }
  assertTrustedOwnerAnchor(resolvedAnchor);
  const realAnchor = fs.realpathSync(resolvedAnchor);
  const relative = path.relative(resolvedAnchor, resolvedDirectory);
  let current = resolvedAnchor;
  if (relative) {
    for (const component of relative.split(path.sep)) {
      current = path.join(current, component);
      if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
      assertPrivateDirectoryNode(current);
      const expectedReal = path.join(realAnchor, path.relative(resolvedAnchor, current));
      if (fs.realpathSync(current) !== expectedReal) throw codedError("unsafe_state_directory", "Bad Rudy's private directory chain contains a symbolic-link escape.");
    }
  }
  return resolvedDirectory;
}

export function assertPrivateDirectoryChain(anchor, directory) {
  const resolvedAnchor = path.resolve(anchor);
  const resolvedDirectory = path.resolve(directory);
  if (resolvedDirectory !== resolvedAnchor && !resolvedDirectory.startsWith(`${resolvedAnchor}${path.sep}`)) {
    throw codedError("unsafe_state_directory", "Bad Rudy refused a private directory outside its owned root.");
  }
  assertTrustedOwnerAnchor(resolvedAnchor);
  const realAnchor = fs.realpathSync(resolvedAnchor);
  const relative = path.relative(resolvedAnchor, resolvedDirectory);
  let current = resolvedAnchor;
  if (relative) {
    for (const component of relative.split(path.sep)) {
      current = path.join(current, component);
      assertPrivateDirectoryNode(current);
      const expectedReal = path.join(realAnchor, path.relative(resolvedAnchor, current));
      if (fs.realpathSync(current) !== expectedReal) throw codedError("unsafe_state_directory", "Bad Rudy's private directory chain contains a symbolic-link escape.");
    }
  }
  return resolvedDirectory;
}

export function assertPrivateRegularFileInside(root, filePath) {
  const resolvedRoot = path.resolve(root);
  const resolvedFile = assertPathInside(resolvedRoot, filePath);
  // A caller-owned artifact/module root remains exactly private even though
  // the user's macOS home anchor may legitimately be 0750.
  assertPrivateDirectoryNode(resolvedRoot);
  assertPrivateDirectoryChain(resolvedRoot, path.dirname(resolvedFile));
  const stat = fs.lstatSync(resolvedFile);
  const expectedReal = path.join(fs.realpathSync(resolvedRoot), path.relative(resolvedRoot, resolvedFile));
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(resolvedFile) !== expectedReal) {
    throw codedError("capture_file_unsafe", "The capture path is not a safe local file.");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw codedError("capture_file_unsafe", "The capture file has the wrong owner.");
  if ((stat.mode & 0o777) !== 0o600) throw codedError("capture_file_unsafe", "Bad Rudy capture files must use mode 0600.");
  return resolvedFile;
}

export function assertPrivateFile(filePath) {
  const resolved = path.resolve(filePath);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw codedError("unsafe_state_file", "Bad Rudy's state file is unsafe.");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw codedError("wrong_state_owner", "Bad Rudy's state file has the wrong owner.");
  if ((stat.mode & 0o777) !== 0o600) throw codedError("unsafe_state_permissions", "Bad Rudy's state files must use mode 0600.");
}

export function readPrivateJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return structuredClone(fallback);
  assertPrivateFile(filePath);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw codedError("state_unreadable", "Bad Rudy's local state could not be read safely.", error);
  }
}

export function atomicWritePrivateJson(filePath, value, { backup = false } = {}) {
  const resolved = path.resolve(filePath);
  const directory = ensurePrivateDirectory(path.dirname(resolved));
  if (fs.existsSync(resolved)) assertPrivateFile(resolved);
  const temporary = path.join(directory, `.${path.basename(resolved)}.${process.pid}.${Date.now()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.chmodSync(temporary, 0o600);
    if (backup && fs.existsSync(resolved)) {
      const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
      const backupPath = path.join(directory, `${path.basename(resolved)}.backup.${timestamp}`);
      fs.copyFileSync(resolved, backupPath, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(backupPath, 0o600);
    }
    fs.renameSync(temporary, resolved);
    assertPrivateFile(resolved);
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function appendPrivateJsonLine(filePath, value) {
  const resolved = path.resolve(filePath);
  const directory = ensurePrivateDirectory(path.dirname(resolved));
  if (fs.existsSync(resolved)) assertPrivateFile(resolved);
  const flags = fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY |
    (fs.constants.O_NOFOLLOW ?? 0);
  const descriptor = fs.openSync(resolved, flags, 0o600);
  try {
    fs.writeSync(descriptor, `${JSON.stringify(value)}\n`, undefined, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(resolved, 0o600);
  assertPrivateFile(resolved);
  fsyncDirectory(directory);
}

export function assertPathInside(root, candidate, code = "path_outside_bad_rudy_storage") {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedCandidate === resolvedRoot || !resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw codedError(code, "Bad Rudy refused a path outside its local storage boundary.");
  }
  return resolvedCandidate;
}

export function dateArtifactDirectory(root, now = new Date()) {
  const date = now.toISOString().slice(0, 10);
  return path.join(path.resolve(root), date);
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertPrivateDirectoryNode(directory) {
  const resolved = path.resolve(directory);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    throw codedError("unsafe_state_directory", "Bad Rudy's private directory chain is unavailable.", error);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw codedError("unsafe_state_directory", "Bad Rudy's private directory chain contains an unsafe component.");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw codedError("wrong_state_owner", "Bad Rudy's private directory chain has the wrong owner.");
  if ((stat.mode & 0o777) !== 0o700) throw codedError("unsafe_state_permissions", "Bad Rudy's private directory chain must use mode 0700.");
}

function assertTrustedOwnerAnchor(directory) {
  const resolved = path.resolve(directory);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    throw codedError("unsafe_state_directory", "Bad Rudy's private directory anchor is unavailable.", error);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw codedError("unsafe_state_directory", "Bad Rudy's private directory anchor is unsafe.");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw codedError("wrong_state_owner", "Bad Rudy's private directory anchor has the wrong owner.");
  }
  // macOS commonly provisions a user's home as 0750. It is a trusted anchor,
  // not Bad Rudy-owned storage. Refuse any group/other write bit, then require
  // every managed descendant to be exactly 0700.
  if ((stat.mode & 0o022) !== 0) {
    throw codedError("unsafe_state_permissions", "Bad Rudy's private directory anchor must not be writable by group or others.");
  }
}
