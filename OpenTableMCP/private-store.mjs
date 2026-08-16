import fs from "node:fs";
import path from "node:path";
import { randomId } from "./canonical.mjs";
import { governed } from "./errors.mjs";

const MAX_JSON_BYTES = 1024 * 1024;

export function ensurePrivateDirectory(directory) {
  const resolved = path.resolve(directory);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw governed("private_directory_invalid", "The OpenTable private state directory is unsafe.");
  fs.chmodSync(resolved, 0o700);
  return resolved;
}

export function readPrivateJson(filePath) {
  assertPrivateFile(filePath);
  const stat = fs.lstatSync(filePath);
  if (stat.size > MAX_JSON_BYTES) throw governed("private_record_too_large", "An OpenTable private record is too large.");
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow());
  try {
    const text = fs.readFileSync(descriptor, "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error?.code) throw error;
    throw governed("private_record_invalid", "An OpenTable private record is invalid.");
  } finally {
    fs.closeSync(descriptor);
  }
}

export function writePrivateJson(filePath, value, { exclusive = false } = {}) {
  const directory = ensurePrivateDirectory(path.dirname(filePath));
  const data = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(data, "utf8") > MAX_JSON_BYTES) throw governed("private_record_too_large", "An OpenTable private record is too large.");
  if (exclusive) {
    const descriptor = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow(), 0o600);
    try { fs.writeFileSync(descriptor, data, "utf8"); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    return;
  }
  if (fs.existsSync(filePath)) assertPrivateFile(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${randomId()}.tmp`);
  const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow(), 0o600);
  try {
    fs.writeFileSync(descriptor, data, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

export function appendPrivateJsonLine(filePath, value) {
  ensurePrivateDirectory(path.dirname(filePath));
  if (fs.existsSync(filePath)) assertPrivateFile(filePath);
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line, "utf8") > 64 * 1024) throw governed("ledger_event_too_large", "An OpenTable ledger event is too large.");
  const descriptor = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | noFollow(), 0o600);
  try { fs.writeFileSync(descriptor, line, "utf8"); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.chmodSync(filePath, 0o600);
}

export function assertPrivateFile(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw governed("private_file_invalid", "An OpenTable private state file is unsafe.");
  if ((stat.mode & 0o077) !== 0) throw governed("private_file_permissions_invalid", "An OpenTable private state file has unsafe permissions.");
}

export function safeRecordPath(directory, id) {
  if (!/^[a-f0-9-]{36}$/u.test(String(id ?? ""))) throw governed("record_id_invalid", "The OpenTable record identifier is invalid.");
  return path.join(ensurePrivateDirectory(directory), `${id}.json`);
}

function noFollow() {
  return fs.constants.O_NOFOLLOW ?? 0;
}
