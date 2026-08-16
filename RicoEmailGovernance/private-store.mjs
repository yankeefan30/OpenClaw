import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function defaultStateDirectory(homeDirectory = os.homedir()) {
  return path.join(
    path.resolve(homeDirectory),
    "Library",
    "Application Support",
    "OpenClaw Studio",
    "governance",
    "rico-email",
  );
}

export function defaultMeetingGrantPath(homeDirectory = os.homedir()) {
  return path.join(defaultStateDirectory(homeDirectory), "meeting-handoff-grant.json");
}

export function ensurePrivateDirectory(directory) {
  const resolved = path.resolve(directory);
  const existed = fs.existsSync(resolved);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw coded("private_directory_invalid");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw coded("private_directory_owner_mismatch");
  if ((stat.mode & 0o777) !== 0o700) {
    if (existed) throw coded("private_directory_mode_invalid");
    fs.chmodSync(resolved, 0o700);
  }
  return resolved;
}

export function assertPrivateDirectory(directory) {
  const stat = fs.lstatSync(path.resolve(directory));
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw coded("private_directory_invalid");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw coded("private_directory_owner_mismatch");
  if ((stat.mode & 0o777) !== 0o700) throw coded("private_directory_mode_invalid");
}

export function assertPrivateFile(filePath) {
  const stat = fs.lstatSync(path.resolve(filePath));
  if (!stat.isFile() || stat.isSymbolicLink()) throw coded("private_file_invalid");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw coded("private_file_owner_mismatch");
  if ((stat.mode & 0o777) !== 0o600) throw coded("private_file_mode_invalid");
}

export function readPrivateJson(filePath) {
  const resolved = path.resolve(filePath);
  assertPrivateDirectory(path.dirname(resolved));
  assertPrivateFile(resolved);
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

export function writePrivateJson(filePath, value, { replace = true, backup = false } = {}) {
  const resolved = path.resolve(filePath);
  const directory = ensurePrivateDirectory(path.dirname(resolved));
  if (fs.existsSync(resolved)) {
    if (!replace) throw coded("private_file_exists");
    assertPrivateFile(resolved);
  }
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
      const backupPath = path.join(directory, `${path.basename(resolved)}.backup.${Date.now()}`);
      fs.copyFileSync(resolved, backupPath, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(backupPath, 0o600);
    }
    fs.renameSync(temporary, resolved);
    assertPrivateFile(resolved);
    syncDirectory(directory);
    return resolved;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function createPrivateJsonExclusive(filePath, value) {
  const resolved = path.resolve(filePath);
  const directory = ensurePrivateDirectory(path.dirname(resolved));
  let descriptor;
  try {
    descriptor = fs.openSync(resolved, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.chmodSync(resolved, 0o600);
    assertPrivateFile(resolved);
    syncDirectory(directory);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
