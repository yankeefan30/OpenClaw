import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalJson, randomId, sha256 } from "./canonical.mjs";
import { governed } from "./errors.mjs";

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_EVENT_BYTES = 64 * 1024;

export function ensurePrivateDirectory(directory) {
  const resolved = path.resolve(directory);
  assertExistingTailNotSymlink(resolved);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw governed("private_directory_invalid", "The Uber private-state directory is unsafe.");
  }
  fs.chmodSync(resolved, 0o700);
  return resolved;
}

export function assertPrivateFile(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw governed("private_file_invalid", "An Uber private-state file is unsafe.");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw governed("private_file_permissions_invalid", "An Uber private-state file has unsafe permissions.");
  }
}

export function readPrivateJson(filePath) {
  assertPrivateFile(filePath);
  const stat = fs.lstatSync(filePath);
  if (stat.size > MAX_JSON_BYTES) throw governed("private_record_too_large", "An Uber private record is too large.");
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow());
  try {
    return JSON.parse(fs.readFileSync(descriptor, "utf8"));
  } catch (error) {
    if (error?.code) throw error;
    throw governed("private_record_invalid", "An Uber private record is invalid.");
  } finally {
    fs.closeSync(descriptor);
  }
}

export function writePrivateJson(filePath, value, { exclusive = false } = {}) {
  const directory = ensurePrivateDirectory(path.dirname(filePath));
  const data = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(data) > MAX_JSON_BYTES) throw governed("private_record_too_large", "An Uber private record is too large.");
  if (exclusive) {
    const descriptor = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow(), 0o600);
    try { fs.writeFileSync(descriptor, data); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fsyncDirectory(directory);
    return;
  }
  if (fs.existsSync(filePath)) assertPrivateFile(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${randomId()}.tmp`);
  const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow(), 0o600);
  try { fs.writeFileSync(descriptor, data); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
  fsyncDirectory(directory);
}

/**
 * Append-only, SHA-256 hash-chained ledger. Every existing entry is verified
 * before an append. Evidence must already be redacted by the caller.
 */
export class HashChainedLedger {
  constructor(filePath, now = () => new Date()) {
    this.filePath = filePath;
    this.now = now;
    ensurePrivateDirectory(path.dirname(filePath));
  }

  readAll() {
    if (!fs.existsSync(this.filePath)) return [];
    assertPrivateFile(this.filePath);
    const descriptor = fs.openSync(this.filePath, fs.constants.O_RDONLY | noFollow());
    let text;
    try { text = fs.readFileSync(descriptor, "utf8"); } finally { fs.closeSync(descriptor); }
    if (Buffer.byteLength(text) > 16 * MAX_JSON_BYTES) throw governed("ledger_too_large", "The Uber audit ledger is too large.");
    const rows = text.split("\n").filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { throw governed("ledger_invalid", "The Uber audit ledger is invalid."); }
    });
    let previousHash = null;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (row.schema !== "openclaw.uber.ledger-event" || row.version !== 1 || row.sequence !== index + 1 || row.previousHash !== previousHash) {
        throw governed("ledger_chain_invalid", "The Uber audit ledger failed integrity verification.");
      }
      const { hash, ...unsigned } = row;
      if (typeof hash !== "string" || hash !== sha256(unsigned)) {
        throw governed("ledger_chain_invalid", "The Uber audit ledger failed integrity verification.");
      }
      previousHash = hash;
    }
    return rows;
  }

  append(type, evidence = {}) {
    return this.withLock(() => this._append(type, evidence));
  }

  _append(type, evidence) {
    const rows = this.readAll();
    const unsigned = {
      schema: "openclaw.uber.ledger-event",
      version: 1,
      sequence: rows.length + 1,
      at: timestamp(this.now),
      type,
      evidence,
      previousHash: rows.at(-1)?.hash ?? null,
    };
    const row = { ...unsigned, hash: sha256(unsigned) };
    const line = `${canonicalJson(row)}\n`;
    if (Buffer.byteLength(line) > MAX_EVENT_BYTES) throw governed("ledger_event_too_large", "An Uber ledger event is too large.");
    if (fs.existsSync(this.filePath)) assertPrivateFile(this.filePath);
    const existed = fs.existsSync(this.filePath);
    const descriptor = fs.openSync(this.filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | noFollow(), 0o600);
    try { fs.writeFileSync(descriptor, line); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.chmodSync(this.filePath, 0o600);
    if (!existed) fsyncDirectory(path.dirname(this.filePath));
    return Object.freeze(row);
  }

  withLock(operation) {
    const lockPath = `${this.filePath}.lock`;
    let descriptor;
    try {
      descriptor = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow(), 0o600);
    } catch (error) {
      if (error?.code === "EEXIST") throw governed("ledger_busy", "The Uber audit ledger is busy; retry later.", { retryable: true });
      throw error;
    }
    try {
      fs.writeFileSync(descriptor, `${process.pid}\n`);
      fs.fsyncSync(descriptor);
      return operation();
    } finally {
      fs.closeSync(descriptor);
      const stat = fs.lstatSync(lockPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw governed("ledger_lock_invalid", "The Uber audit ledger lock is unsafe.");
      fs.unlinkSync(lockPath);
    }
  }
}

export function safeRecordPath(directory, id) {
  if (!/^[a-f0-9-]{36}$/u.test(String(id ?? ""))) throw governed("record_id_invalid", "The Uber record identifier is invalid.");
  const base = ensurePrivateDirectory(directory);
  const candidate = path.resolve(base, `${id}.json`);
  if (!candidate.startsWith(`${base}${path.sep}`)) throw governed("record_path_escape", "The Uber record path escaped its private directory.");
  return candidate;
}

function noFollow() { return fs.constants.O_NOFOLLOW ?? 0; }

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | noFollow());
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function assertExistingTailNotSymlink(resolved) {
  const home = path.resolve(os.homedir());
  if (resolved === home || resolved.startsWith(`${home}${path.sep}`)) {
    let cursor = home;
    const relative = path.relative(home, resolved);
    const components = relative ? relative.split(path.sep) : [];
    for (const component of ["", ...components]) {
      if (component) cursor = path.join(cursor, component);
      if (!fs.existsSync(cursor)) break;
      if (fs.lstatSync(cursor).isSymbolicLink()) throw governed("private_path_symlink", "The Uber private-state path contains an unsafe symlink component.");
    }
    return;
  }
  let cursor = resolved;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const stat = fs.lstatSync(cursor);
  if (stat.isSymbolicLink()) throw governed("private_path_symlink", "The Uber private-state path contains an unsafe symlink boundary.");
}

function timestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw governed("clock_invalid", "The Uber governance clock is invalid.");
  return date.toISOString();
}
