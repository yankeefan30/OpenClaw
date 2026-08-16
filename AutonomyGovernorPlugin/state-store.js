import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const STATE_SCHEMA = "rico.autonomy.governor-state";
export const STATE_SCHEMA_VERSION = 1;
export const LEDGER_SCHEMA = "rico.autonomy.governor-ledger-event";
export const LEDGER_SCHEMA_VERSION = 1;
export const ZERO_HASH = "0".repeat(64);

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

export function canonicalStringify(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new StoreError("INVALID_NUMBER", "Non-finite numbers are not canonical JSON.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new StoreError("INVALID_JSON", "Value is not representable as canonical JSON.");
}

export function sha256(value) {
  const input = typeof value === "string" ? value : canonicalStringify(value);
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

export function defaultState(now = Date.now()) {
  return {
    schema: STATE_SCHEMA,
    schemaVersion: STATE_SCHEMA_VERSION,
    revision: 0,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    globalPaused: true,
    globalPauseReason: "Safe default: explicit operator resume required.",
    missions: {},
    counters: {},
    runs: {},
    intents: {},
    operations: {},
    ledger: { sequence: 0, tailHash: ZERO_HASH },
  };
}

function modeString(stat) {
  return `0${(stat.mode & 0o777).toString(8)}`;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StoreError("STATE_INVALID", `${label} must be an object.`);
  }
}

function validateStateShape(state) {
  assertPlainObject(state, "Governor state");
  if (state.schema !== STATE_SCHEMA || state.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new StoreError("STATE_SCHEMA_MISMATCH", "Governor state schema is unsupported.");
  }
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) throw new StoreError("STATE_INVALID", "State revision is invalid.");
  if (typeof state.globalPaused !== "boolean") throw new StoreError("STATE_INVALID", "Global pause state is invalid.");
  for (const key of ["missions", "counters", "runs", "intents", "operations", "ledger"]) assertPlainObject(state[key], `state.${key}`);
  if (!Number.isSafeInteger(state.ledger.sequence) || state.ledger.sequence < 0 || !/^[a-f0-9]{64}$/.test(state.ledger.tailHash)) {
    throw new StoreError("STATE_INVALID", "Ledger checkpoint is invalid.");
  }
}

function ensureNotSymlink(target, label) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new StoreError("UNSAFE_PATH", `${label} must not be a symbolic link.`);
}

function ensureDirectory(directory) {
  ensureNotSymlink(directory, "State directory");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory()) throw new StoreError("UNSAFE_PATH", "State directory is not a directory.");
  fs.chmodSync(directory, 0o700);
}

function ensurePrivateFile(file) {
  ensureNotSymlink(file, path.basename(file));
  if (!fs.existsSync(file)) {
    const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.closeSync(fd);
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new StoreError("UNSAFE_PATH", `${path.basename(file)} is not a regular file.`);
  fs.chmodSync(file, 0o600);
}

function fsyncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function atomicWriteJson(file, value) {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const payload = `${canonicalStringify(value)}\n`;
  let fd;
  try {
    fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeFileSync(fd, payload, { encoding: "utf8" });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
    fsyncDirectory(directory);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function ledgerHash(eventWithoutHash) {
  return sha256(eventWithoutHash);
}

export class DurableStateStore {
  constructor(directory, { now = () => Date.now() } = {}) {
    if (typeof directory !== "string" || !path.isAbsolute(directory)) {
      throw new StoreError("INVALID_STATE_DIRECTORY", "Governor stateDirectory must be an absolute path.");
    }
    this.directory = path.normalize(directory);
    this.statePath = path.join(this.directory, "state.json");
    this.ledgerPath = path.join(this.directory, "ledger.jsonl");
    this.now = now;
    this.healthy = false;
    this.healthReasons = [];
    this.state = undefined;
    this.#open();
  }

  #open() {
    try {
      ensureDirectory(this.directory);
      ensurePrivateFile(this.ledgerPath);
      if (fs.existsSync(this.statePath)) {
        ensurePrivateFile(this.statePath);
        this.state = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
        validateStateShape(this.state);
      } else {
        this.state = defaultState(this.now());
        atomicWriteJson(this.statePath, this.state);
      }
      this.verifyLedger();
      this.healthy = true;
      this.healthReasons = [];
    } catch (error) {
      this.healthy = false;
      this.healthReasons = [error instanceof Error ? error.message : String(error)];
      // Never expose or enforce from a partially parsed, unsupported state.
      // The in-memory fallback is paused and empty; the original file remains
      // untouched for operator recovery and bounded activation stays disabled.
      this.state = defaultState(this.now());
    }
  }

  verifyLedger() {
    const raw = fs.readFileSync(this.ledgerPath, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim() !== "");
    let previous = ZERO_HASH;
    let sequence = 0;
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        throw new StoreError("LEDGER_CORRUPT", "Ledger contains invalid JSON.");
      }
      if (event.schema !== LEDGER_SCHEMA || event.schemaVersion !== LEDGER_SCHEMA_VERSION) {
        throw new StoreError("LEDGER_SCHEMA_MISMATCH", "Ledger schema is unsupported.");
      }
      if (event.sequence !== sequence + 1 || event.previousHash !== previous || typeof event.hash !== "string") {
        throw new StoreError("LEDGER_CHAIN_INVALID", "Ledger hash chain is discontinuous.");
      }
      const { hash, ...unsigned } = event;
      if (ledgerHash(unsigned) !== hash) throw new StoreError("LEDGER_CHAIN_INVALID", "Ledger event hash does not verify.");
      previous = hash;
      sequence = event.sequence;
    }
    if (sequence !== this.state.ledger.sequence || previous !== this.state.ledger.tailHash) {
      throw new StoreError("LEDGER_CHECKPOINT_MISMATCH", "State and ledger checkpoints do not match.");
    }
    return { sequence, tailHash: previous };
  }

  assertHealthy() {
    if (!this.healthy) throw new StoreError("GOVERNOR_UNHEALTHY", "Autonomy governor state is not healthy.");
  }

  snapshot() {
    return structuredClone(this.state);
  }

  transact(type, details, mutate) {
    this.assertHealthy();
    const next = structuredClone(this.state);
    // Policy, revision, and budget rejections happen before any durable write
    // and must not poison an otherwise healthy store.
    const result = mutate(next);
    next.revision += 1;
    next.updatedAt = new Date(this.now()).toISOString();
    const unsigned = {
      schema: LEDGER_SCHEMA,
      schemaVersion: LEDGER_SCHEMA_VERSION,
      sequence: this.state.ledger.sequence + 1,
      timestamp: next.updatedAt,
      type,
      missionId: typeof details?.missionId === "string" ? details.missionId : undefined,
      details: details ?? {},
      stateRevision: next.revision,
      previousHash: this.state.ledger.tailHash,
    };
    const event = { ...unsigned, hash: ledgerHash(unsigned) };
    try {
      const fd = fs.openSync(this.ledgerPath, fs.constants.O_APPEND | fs.constants.O_WRONLY, 0o600);
      try {
        fs.writeSync(fd, `${canonicalStringify(event)}\n`, undefined, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      next.ledger = { sequence: event.sequence, tailHash: event.hash };
      atomicWriteJson(this.statePath, next);
      this.state = next;
      return { result, event };
    } catch (error) {
      // A failure after the ledger append can leave the state checkpoint behind.
      // Revoke the in-process authority immediately; only a verified reopen may
      // make the store healthy again.
      this.healthy = false;
      this.healthReasons = [error instanceof Error ? error.message : String(error)];
      throw error;
    }
  }

  readEvents({ missionId, limit = 100, cursor = 0 } = {}) {
    this.assertHealthy();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new StoreError("INVALID_PARAMS", "limit must be between 1 and 500.");
    const before = cursor === undefined || cursor === null || cursor === "" || cursor === 0 ? Number.POSITIVE_INFINITY : Number(cursor);
    if (before !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(before) || before < 1)) throw new StoreError("INVALID_PARAMS", "cursor must be a positive ledger sequence.");
    const lines = fs.readFileSync(this.ledgerPath, "utf8").split("\n").filter(Boolean);
    const eligible = lines
      .map((line) => JSON.parse(line))
      .filter((event) => event.sequence < before && (!missionId || event.missionId === missionId))
      .sort((left, right) => right.sequence - left.sequence);
    const events = eligible.slice(0, limit);
    const nextCursor = eligible.length > events.length && events.length > 0 ? String(events.at(-1).sequence) : null;
    return { events, nextCursor };
  }

  permissions() {
    const inspect = (target, expected) => {
      try {
        const stat = fs.lstatSync(target);
        return { expected, actual: modeString(stat), secure: modeString(stat) === expected, symlink: stat.isSymbolicLink() };
      } catch {
        return { expected, actual: null, secure: false, symlink: false };
      }
    };
    return {
      directory: inspect(this.directory, "0700"),
      state: inspect(this.statePath, "0600"),
      ledger: inspect(this.ledgerPath, "0600"),
    };
  }
}
