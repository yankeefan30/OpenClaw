import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validatePermissionGrant } from "./policy.mjs";

export function defaultStateDirectory(homeDirectory = os.homedir()) {
  return path.join(
    path.resolve(homeDirectory),
    "Library",
    "Application Support",
    "OpenClaw Studio",
    "workflows",
    "janet-receipt",
  );
}

export function defaultGrantPath(homeDirectory = os.homedir()) {
  return path.join(defaultStateDirectory(homeDirectory), "permission-grant.json");
}

export function ensurePrivateDirectory(directory) {
  const resolved = path.resolve(directory);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("private state path is not a real directory");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("private state directory has the wrong owner");
  if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(resolved, 0o700);
  return resolved;
}

export function assertPrivateFile(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("private file is not a regular file");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("private file has the wrong owner");
  if ((stat.mode & 0o777) !== 0o600) throw new Error("private file mode must be 0600");
}

export function readPrivateGrant(filePath = defaultGrantPath()) {
  const resolved = path.resolve(filePath);
  assertPrivateDirectory(path.dirname(resolved));
  assertPrivateFile(resolved);
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  return validatePermissionGrant(parsed);
}

export function installPrivateGrant(value, { filePath = defaultGrantPath(), replace = false } = {}) {
  const grant = validatePermissionGrant(value);
  const resolved = path.resolve(filePath);
  const directory = ensurePrivateDirectory(path.dirname(resolved));
  if (fs.existsSync(resolved) && !replace) throw new Error("permission grant already exists; pass replace only after explicit review");
  if (fs.existsSync(resolved)) assertPrivateFile(resolved);

  const temporary = path.join(directory, `.permission-grant.${process.pid}.${Date.now()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(grant, null, 2)}\n`, { encoding: "utf8" });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.chmodSync(temporary, 0o600);
    if (fs.existsSync(resolved)) {
      const backup = path.join(directory, `permission-grant.backup.${Date.now()}.json`);
      fs.copyFileSync(resolved, backup, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(backup, 0o600);
    }
    fs.renameSync(temporary, resolved);
    assertPrivateFile(resolved);
    const directoryDescriptor = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
    return resolved;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function assertPrivateDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("grant parent is not a real directory");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("grant parent has the wrong owner");
  if ((stat.mode & 0o777) !== 0o700) throw new Error("grant parent mode must be 0700");
}
