import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_SCHEMA_VERSION = 1;
const MAX_ENTRIES = 200;
const ENTRY_TTL_MS = 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT = 3;
const GLOBAL_RATE_LIMIT = 10;
const DEDUPE_BUCKET_MS = 60 * 1000;
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 5 * 1000;
const REQUEST_ID_PATTERN = /^rico_[0-9]{8}T[0-9]{9}Z_[a-f0-9]{32}$/u;
const STATUS = new Set(["reserved", "submitted", "terminal"]);
const OUTCOMES = new Set([null, "complete", "unverified", "failed"]);

export const AUTOMATIC_IMT_UNVERIFIED_REPLY =
  "Rico: I couldn’t verify a current IMT or Command Center update within this response, so I won’t guess. Please ask Rico again.";

export const AUTOMATIC_IMT_ALREADY_TRIED = Object.freeze([
  "Static IMT vocabulary is available; current operational status requires independent verification.",
]);

export const AUTOMATIC_IMT_DONE_LOOKS_LIKE =
  "A current IMT or Command Center status supported by time-bounded authoritative evidence, with unresolved limits stated explicitly.";

export function defaultAutomaticIMTStatePath() {
  return path.join(os.homedir(), "Library", "Application Support", "OpenClaw Studio", "rico-imt-polar-state.json");
}

export function automaticIMTIdempotencyKey({ conversation, sender, timestamp, content }) {
  const exactConversation = bounded(conversation, 1, 1_200, "automatic_imt_conversation_invalid");
  const exactSender = normalizedHandle(sender);
  const timestampMs = trustedTimestamp(timestamp);
  const exactContent = bounded(content, 1, 500, "automatic_imt_content_invalid", { multiline: true });
  const eventKey = sha256([exactConversation, exactSender, String(timestampMs), exactContent].join("\0"));
  const dedupeKey = sha256([
    exactConversation,
    exactSender,
    String(Math.floor(timestampMs / DEDUPE_BUCKET_MS)),
    sha256(exactContent),
  ].join("\0"));
  return Object.freeze({ eventKey, dedupeKey, timestampMs });
}

export function automaticIMTRequestId({ eventKey, audienceScope, timestamp }) {
  const key = digest(eventKey, "automatic_imt_event_key_invalid");
  const scope = digest(audienceScope, "automatic_imt_audience_scope_invalid");
  const stamp = new Date(trustedTimestamp(timestamp)).toISOString().replace(/[-:.]/gu, "");
  const requestId = `rico_${stamp}_${sha256(`${key}\0${scope}`).slice(0, 32)}`;
  if (!REQUEST_ID_PATTERN.test(requestId)) throw coded("automatic_imt_request_id_invalid");
  return requestId;
}

export class AutomaticIMTRequestRegistry {
  #filePath;
  #supportDirectory;
  #now;
  #tail = Promise.resolve();
  #allowTestDirectory;
  #allowedRoot;

  constructor({
    filePath = defaultAutomaticIMTStatePath(),
    supportDirectory = path.dirname(filePath),
    now = () => Date.now(),
    allowTestDirectory = false,
    allowedRoot,
  } = {}) {
    this.#filePath = exactAbsolutePath(filePath, "automatic_imt_state_path_invalid");
    this.#supportDirectory = exactAbsolutePath(supportDirectory, "automatic_imt_support_path_invalid");
    this.#allowedRoot = allowedRoot === undefined
      ? undefined
      : exactAbsolutePath(allowedRoot, "automatic_imt_allowed_root_invalid");
    if (path.dirname(this.#filePath) !== this.#supportDirectory || typeof now !== "function" ||
        (this.#allowedRoot !== undefined && this.#allowedRoot !== this.#supportDirectory) ||
        (allowTestDirectory === true && this.#allowedRoot !== undefined)) {
      throw coded("automatic_imt_registry_config_invalid");
    }
    this.#now = now;
    this.#allowTestDirectory = allowTestDirectory === true;
  }

  claim({ eventKey, dedupeKey, audienceFingerprint, audienceScope, requestId, at }) {
    const input = Object.freeze({
      eventKey: digest(eventKey, "automatic_imt_event_key_invalid"),
      dedupeKey: digest(dedupeKey, "automatic_imt_dedupe_key_invalid"),
      audienceFingerprint: digest(audienceFingerprint, "automatic_imt_audience_fingerprint_invalid"),
      audienceScope: digest(audienceScope, "automatic_imt_audience_scope_invalid"),
      requestId: exactRequestId(requestId),
      at: isoDate(at, "automatic_imt_claim_time_invalid"),
    });
    return this.#transaction((state) => {
      pruneState(state, Date.parse(input.at));
      const eventMatch = state.entries.find((entry) => entry.eventKey === input.eventKey);
      const dedupeMatch = state.entries.find((entry) => entry.dedupeKey === input.dedupeKey &&
        entry.audienceFingerprint === input.audienceFingerprint);
      if (eventMatch) {
        if (eventMatch.audienceFingerprint !== input.audienceFingerprint ||
            eventMatch.audienceScope !== input.audienceScope || eventMatch.requestId !== input.requestId) {
          eventMatch.status = "terminal";
          eventMatch.outcome = "failed";
          eventMatch.updatedAt = input.at;
          return Object.freeze({ disposition: "quarantined", eventKey: eventMatch.eventKey });
        }
        if (eventMatch.status === "submitted") {
          return Object.freeze({
            disposition: "resume",
            eventKey: eventMatch.eventKey,
            requestId: eventMatch.requestId,
            audienceScope: eventMatch.audienceScope,
          });
        }
        if (eventMatch.status === "reserved") {
          return Object.freeze({
            disposition: "recover",
            eventKey: eventMatch.eventKey,
            requestId: eventMatch.requestId,
            audienceScope: eventMatch.audienceScope,
          });
        }
        return Object.freeze({ disposition: "duplicate", eventKey: eventMatch.eventKey });
      }
      // The minute-bucket key suppresses repeat prompts but never grants
      // authority to poll or answer a different inbound event.
      if (dedupeMatch) return Object.freeze({ disposition: "duplicate", eventKey: dedupeMatch.eventKey });
      const cutoff = Date.parse(input.at) - RATE_WINDOW_MS;
      const recent = state.entries.filter((entry) => entry.audienceFingerprint === input.audienceFingerprint &&
        Date.parse(entry.createdAt) >= cutoff);
      const globalRecent = state.entries.filter((entry) => Date.parse(entry.createdAt) >= cutoff);
      if (recent.length >= RATE_LIMIT || globalRecent.length >= GLOBAL_RATE_LIMIT) {
        makeRoomForEntry(state);
        state.entries.push({
          eventKey: input.eventKey,
          dedupeKey: input.dedupeKey,
          audienceFingerprint: input.audienceFingerprint,
          audienceScope: input.audienceScope,
          status: "terminal",
          requestId: input.requestId,
          outcome: "failed",
          createdAt: input.at,
          updatedAt: input.at,
        });
        return Object.freeze({ disposition: "rate_limited", eventKey: input.eventKey });
      }
      makeRoomForEntry(state);
      state.entries.push({
        eventKey: input.eventKey,
        dedupeKey: input.dedupeKey,
        audienceFingerprint: input.audienceFingerprint,
        audienceScope: input.audienceScope,
        status: "reserved",
        requestId: input.requestId,
        outcome: null,
        createdAt: input.at,
        updatedAt: input.at,
      });
      return Object.freeze({
        disposition: "new",
        eventKey: input.eventKey,
        requestId: input.requestId,
        audienceScope: input.audienceScope,
      });
    });
  }

  markSubmitted({ eventKey, requestId, at }) {
    const key = digest(eventKey, "automatic_imt_event_key_invalid");
    const id = exactRequestId(requestId);
    const timestamp = isoDate(at, "automatic_imt_submit_time_invalid");
    return this.#transaction((state) => {
      const entry = exactEntry(state, key);
      if (entry.status !== "reserved") throw coded("automatic_imt_request_not_reserved");
      if (entry.requestId !== id) throw coded("automatic_imt_request_id_mismatch");
      entry.status = "submitted";
      entry.requestId = id;
      entry.updatedAt = timestamp;
      return Object.freeze({ eventKey: key, requestId: id, audienceScope: entry.audienceScope });
    });
  }

  markTerminal({ eventKey, outcome, at }) {
    const key = digest(eventKey, "automatic_imt_event_key_invalid");
    const exactOutcome = String(outcome ?? "");
    if (!new Set(["complete", "unverified", "failed"]).has(exactOutcome)) throw coded("automatic_imt_outcome_invalid");
    const timestamp = isoDate(at, "automatic_imt_terminal_time_invalid");
    return this.#transaction((state) => {
      const entry = exactEntry(state, key);
      entry.status = "terminal";
      entry.outcome = exactOutcome;
      entry.updatedAt = timestamp;
      return Object.freeze({ eventKey: key, outcome: exactOutcome });
    });
  }

  #transaction(operation) {
    const run = this.#tail.then(async () => {
      const lock = await this.#acquireLock();
      try {
        const state = await this.#read();
        const result = operation(state);
        await this.#write(state);
        return result;
      } finally {
        await this.#releaseLock(lock);
      }
    });
    this.#tail = run.catch(() => undefined);
    return run;
  }

  async #read() {
    await assertPrivateDirectory(this.#supportDirectory, this.#allowTestDirectory, this.#allowedRoot);
    if (!fs.existsSync(this.#filePath)) return { schemaVersion: STATE_SCHEMA_VERSION, entries: [] };
    const stat = await fs.promises.lstat(this.#filePath);
    assertPrivateFile(stat);
    if (await fs.promises.realpath(this.#filePath) !== this.#filePath || stat.size > 512 * 1024) {
      throw coded("automatic_imt_state_file_invalid");
    }
    const value = JSON.parse(await fs.promises.readFile(this.#filePath, "utf8"));
    validateState(value);
    return value;
  }

  async #write(state) {
    validateState(state);
    const temporary = path.join(this.#supportDirectory, `.rico-imt-polar-${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.promises.open(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.promises.rename(temporary, this.#filePath);
      const stat = await fs.promises.lstat(this.#filePath);
      assertPrivateFile(stat);
      const directoryHandle = await fs.promises.open(this.#supportDirectory, fs.constants.O_RDONLY);
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } finally {
      if (handle) await handle.close();
      try { if (fs.existsSync(temporary)) await fs.promises.unlink(temporary); } catch { /* next transaction fails closed */ }
    }
  }

  async #acquireLock() {
    await assertPrivateDirectory(this.#supportDirectory, this.#allowTestDirectory, this.#allowedRoot);
    const lockPath = path.join(this.#supportDirectory, ".rico-imt-polar.lock");
    const started = Date.now();
    for (;;) {
      const token = crypto.randomBytes(32).toString("hex");
      let handle;
      try {
        const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY |
          (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_CLOEXEC ?? 0);
        handle = await fs.promises.open(lockPath, flags, 0o600);
        const createdAt = new Date(exactClock(this.#now())).toISOString();
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, token, createdAt })}\n`, "utf8");
        await handle.sync();
        const stat = await handle.stat();
        assertPrivateFile(stat);
        await handle.close();
        return Object.freeze({ lockPath, token, dev: stat.dev, ino: stat.ino });
      } catch (error) {
        if (handle) await handle.close().catch(() => {});
        if (error?.code !== "EEXIST") throw error;
        let existing;
        try {
          existing = await readLock(lockPath);
        } catch (lockError) {
          if (lockError?.code === "ENOENT") continue;
          if (lockError?.code === "automatic_imt_registry_lock_invalid" &&
              Date.now() - started < LOCK_TIMEOUT_MS) {
            await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
            continue;
          }
          throw lockError;
        }
        const age = exactClock(this.#now()) - Date.parse(existing.createdAt);
        if (age >= 0 && !processIsAlive(existing.pid)) {
          const current = await fs.promises.lstat(lockPath);
          assertPrivateFile(current);
          if (current.dev !== existing.dev || current.ino !== existing.ino) continue;
          await fs.promises.unlink(lockPath);
          continue;
        }
        if (Date.now() - started >= LOCK_TIMEOUT_MS) throw coded("automatic_imt_registry_lock_timeout");
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
  }

  async #releaseLock(lock) {
    const existing = await readLock(lock.lockPath);
    if (existing.token !== lock.token || existing.dev !== lock.dev || existing.ino !== lock.ino) {
      throw coded("automatic_imt_registry_lock_changed");
    }
    await fs.promises.unlink(lock.lockPath);
  }
}

function validateState(value) {
  exactKeys(value, ["schemaVersion", "entries"], "automatic_imt_state_invalid");
  if (value.schemaVersion !== STATE_SCHEMA_VERSION || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) {
    throw coded("automatic_imt_state_invalid");
  }
  const eventKeys = new Set();
  for (const entry of value.entries) {
    exactKeys(entry, [
      "eventKey", "dedupeKey", "audienceFingerprint", "audienceScope", "status", "requestId", "outcome",
      "createdAt", "updatedAt",
    ], "automatic_imt_state_entry_invalid");
    for (const name of ["eventKey", "dedupeKey", "audienceFingerprint", "audienceScope"]) {
      digest(entry[name], "automatic_imt_state_entry_invalid");
    }
    if (eventKeys.has(entry.eventKey) || !STATUS.has(entry.status) || !OUTCOMES.has(entry.outcome)) {
      throw coded("automatic_imt_state_entry_invalid");
    }
    eventKeys.add(entry.eventKey);
    isoDate(entry.createdAt, "automatic_imt_state_entry_invalid");
    isoDate(entry.updatedAt, "automatic_imt_state_entry_invalid");
    exactRequestId(entry.requestId);
    if (entry.status === "terminal" ? entry.outcome === null : entry.outcome !== null) {
      throw coded("automatic_imt_state_entry_invalid");
    }
  }
  return true;
}

function pruneState(state, at) {
  state.entries = state.entries
    .filter((entry) => Date.parse(entry.updatedAt) >= at - ENTRY_TTL_MS)
    .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt))
    .slice(-MAX_ENTRIES);
}

function makeRoomForEntry(state) {
  if (state.entries.length < MAX_ENTRIES) return;
  const terminal = state.entries.findIndex((entry) => entry.status === "terminal");
  if (terminal < 0) throw coded("automatic_imt_registry_capacity");
  state.entries.splice(terminal, 1);
}

function exactEntry(state, eventKey) {
  const matches = state.entries.filter((entry) => entry.eventKey === eventKey);
  if (matches.length !== 1) throw coded("automatic_imt_request_unavailable");
  return matches[0];
}

async function assertPrivateDirectory(directory, allowTestDirectory, allowedRoot) {
  if (!allowTestDirectory && directory !== path.dirname(defaultAutomaticIMTStatePath()) && directory !== allowedRoot) {
    throw coded("automatic_imt_support_path_invalid");
  }
  const stat = await fs.promises.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o777) !== 0o700 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
      await fs.promises.realpath(directory) !== directory) throw coded("automatic_imt_support_directory_unsafe");
}

async function readLock(lockPath) {
  const stat = await fs.promises.lstat(lockPath);
  assertPrivateFile(stat);
  if (stat.size < 2 || stat.size > 1024 || await fs.promises.realpath(lockPath) !== lockPath) {
    throw coded("automatic_imt_registry_lock_invalid");
  }
  let value;
  try {
    value = JSON.parse(await fs.promises.readFile(lockPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw error;
    throw coded("automatic_imt_registry_lock_invalid");
  }
  exactKeys(value, ["pid", "token", "createdAt"], "automatic_imt_registry_lock_invalid");
  if (!Number.isSafeInteger(value.pid) || value.pid < 1 || !/^[a-f0-9]{64}$/u.test(String(value.token ?? "")) ||
      !Number.isFinite(Date.parse(value.createdAt))) throw coded("automatic_imt_registry_lock_invalid");
  return Object.freeze({ ...value, dev: stat.dev, ino: stat.ino });
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function assertPrivateFile(stat) {
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw coded("automatic_imt_state_file_unsafe");
  }
}

function exactAbsolutePath(value, code) {
  const text = String(value ?? "");
  if (!path.isAbsolute(text) || path.resolve(text) !== text) throw coded(code);
  return text;
}

function normalizedHandle(value) {
  const text = bounded(value, 3, 254, "automatic_imt_sender_invalid").toLowerCase();
  if (/^\+[1-9][0-9]{6,14}$/u.test(text) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(text)) return text;
  throw coded("automatic_imt_sender_invalid");
}

function trustedTimestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw coded("automatic_imt_timestamp_invalid");
  const milliseconds = number < 10_000_000_000 ? number * 1000 : number;
  if (!Number.isSafeInteger(milliseconds) || !Number.isFinite(Date.parse(new Date(milliseconds).toISOString()))) {
    throw coded("automatic_imt_timestamp_invalid");
  }
  return milliseconds;
}

function exactClock(value) {
  const number = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(number) || number < 0) throw coded("automatic_imt_clock_invalid");
  return number;
}

function isoDate(value, code) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw coded(code);
  return date.toISOString();
}

function digest(value, code) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(text)) throw coded(code);
  return text;
}

function exactRequestId(value) {
  const text = String(value ?? "").trim();
  if (!REQUEST_ID_PATTERN.test(text)) throw coded("automatic_imt_request_id_invalid");
  return text;
}

function bounded(value, min, max, code, { multiline = false } = {}) {
  const text = String(value ?? "").normalize("NFC").trim();
  const controls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u : /[\u0000-\u001f\u007f-\u009f]/u;
  if (text.length < min || text.length > max || controls.test(text)) throw coded(code);
  return text;
}

function exactKeys(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw coded(code);
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) throw coded(code);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
