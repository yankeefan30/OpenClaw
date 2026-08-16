import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertPrivateFile, defaultStateDirectory, ensurePrivateDirectory } from "./grant.mjs";

const LEDGER_SCHEMA = "rico.janet-receipt-ledger";
const EVIDENCE_SCHEMA = "rico.janet-receipt-evidence";
const MAX_RECORDS = 100;
const OUTCOMES = new Set([
  "pending",
  "sent",
  "not_found",
  "blocked_login",
  "blocked_ambiguous",
  "blocked_evidence",
  "blocked_signature",
  "email_outcome_unknown",
  "failed",
]);
const ALLOWED_EVIDENCE_KEYS = new Set([
  "alias",
  "amountHash",
  "dateHash",
  "errorCode",
  "fromFingerprint",
  "legacyPathHash",
  "locationsHash",
  "matchCount",
  "outcome",
  "pdfBytes",
  "pdfSha256",
  "providerMessageIdHash",
  "reason",
  "recipientFingerprint",
  "senderFingerprint",
  "sessionIdHash",
  "signatureHash",
  "sourceLocationHash",
  "sourceRecordIdHash",
  "vendorHash",
]);

export function defaultLedgerPath(homeDirectory = os.homedir()) {
  return path.join(defaultStateDirectory(homeDirectory), "ledger.json");
}

export function defaultEvidencePath(homeDirectory = os.homedir()) {
  return path.join(defaultStateDirectory(homeDirectory), "evidence.jsonl");
}

export function legacyLedgerPaths(homeDirectory = os.homedir()) {
  const home = path.resolve(homeDirectory);
  return [
    path.join(home, "Library", "Application Support", "OpenClaw Studio", "workflows", "janet-receipt", "ledger.jsonl"),
    path.join(home, ".openclaw", "workspace", "brain", "workflows", ".state", "janet-receipt-ledger.jsonl"),
    path.join(home, ".openclaw", "workspace", "brain", "workflows", "state", "janet-receipt-ledger.jsonl"),
    path.join(home, "Library", "Application Support", "OpenClaw Studio", "janet-receipt-ledger.jsonl"),
  ];
}

export class ReceiptLedger {
  constructor(filePath = defaultLedgerPath(), evidencePath) {
    this.filePath = path.resolve(filePath);
    this.directory = path.dirname(this.filePath);
    this.evidencePath = path.resolve(evidencePath ?? path.join(this.directory, "evidence.jsonl"));
    if (path.dirname(this.evidencePath) !== this.directory) throw new Error("ledger and evidence must share one private directory");
    this.lockPath = path.join(this.directory, ".ledger.lock");
  }

  records() {
    if (!fs.existsSync(this.filePath)) return [];
    assertPrivateFile(this.filePath);
    return validateLedgerObject(JSON.parse(fs.readFileSync(this.filePath, "utf8"))).records;
  }

  entries() {
    if (!fs.existsSync(this.evidencePath)) return [];
    assertPrivateFile(this.evidencePath);
    return validateEvidenceText(fs.readFileSync(this.evidencePath, "utf8"));
  }

  claim({ requestKey, runId, at, record, evidence = {} }) {
    return this.#withLock(() => {
      const entries = this.entries();
      if (entries.some((entry) => entry.requestKey === requestKey)) return false;
      const reviewedRecord = validateRecord({ ...record, outcome: "pending" });
      this.#appendEvidenceUnlocked(entries, { requestKey, runId, transition: "claimed", at, evidence });
      const records = this.records().filter((item) => !(item.chat_guid === reviewedRecord.chat_guid && item.message_ts === reviewedRecord.message_ts));
      records.push(reviewedRecord);
      this.#writeLedgerUnlocked(records.slice(-MAX_RECORDS));
      return true;
    });
  }

  append({ requestKey, runId, transition, at, evidence = {} }) {
    return this.#withLock(() => {
      const entries = this.entries();
      if (!entries.some((entry) => entry.requestKey === requestKey)) throw new Error("request must be claimed before transitions are appended");
      return this.#appendEvidenceUnlocked(entries, { requestKey, runId, transition, at, evidence });
    });
  }

  reserveEmail({ requestKey, runId, at, evidence = {} }) {
    return this.#withLock(() => {
      const entries = this.entries();
      const requestEntries = entries.filter((entry) => entry.requestKey === requestKey);
      if (requestEntries.length === 0) throw new Error("request must be claimed before reserving email");
      if (requestEntries.some((entry) => ["email_reserved", "email_sent", "email_outcome_unknown"].includes(entry.transition))) return false;
      this.#appendEvidenceUnlocked(entries, { requestKey, runId, transition: "email_reserved", at, evidence });
      return true;
    });
  }

  finalize({ requestKey, runId, at, vendor, outcome, evidence = {} }) {
    return this.#withLock(() => {
      if (!OUTCOMES.has(outcome) || outcome === "pending") throw new Error("final ledger outcome is invalid");
      const entries = this.entries();
      if (!entries.some((entry) => entry.requestKey === requestKey)) throw new Error("request must be claimed before finalization");
      this.#appendEvidenceUnlocked(entries, { requestKey, runId, transition: "finalized", at, evidence: { ...evidence, outcome } });
      const records = this.records();
      const index = records.findIndex((record) => record.request_hash === requestKey);
      if (index < 0) throw new Error("recent ledger record is unavailable for finalization");
      records[index] = validateRecord({ ...records[index], vendor: vendor ?? records[index].vendor, outcome });
      this.#writeLedgerUnlocked(records.slice(-MAX_RECORDS));
      return records[index];
    });
  }

  #appendEvidenceUnlocked(entries, { requestKey, runId, transition, at, evidence }) {
    assertDigest(requestKey, "requestKey");
    if (!/^[A-Za-z0-9:._-]{1,128}$/u.test(String(runId ?? ""))) throw new Error("runId is invalid");
    if (!/^[a-z][a-z0-9_]{1,63}$/u.test(String(transition ?? ""))) throw new Error("invalid evidence transition");
    const timestamp = new Date(at ?? Date.now());
    if (Number.isNaN(timestamp.getTime())) throw new Error("invalid evidence timestamp");
    const cleanedEvidence = validateEvidence(evidence);
    const previousHash = entries.at(-1)?.hash ?? "0".repeat(64);
    const unsigned = {
      schema: EVIDENCE_SCHEMA,
      schemaVersion: 2,
      sequence: entries.length + 1,
      at: timestamp.toISOString(),
      requestKey,
      runId: String(runId),
      transition: String(transition),
      evidence: cleanedEvidence,
      previousHash,
    };
    const entry = { ...unsigned, hash: digest(canonicalJson(unsigned)) };
    ensurePrivateDirectory(this.directory);
    const descriptor = fs.openSync(this.evidencePath, "a", 0o600);
    try {
      fs.writeSync(descriptor, `${JSON.stringify(entry)}\n`, null, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.chmodSync(this.evidencePath, 0o600);
    return entry;
  }

  #writeLedgerUnlocked(records) {
    ensurePrivateDirectory(this.directory);
    const value = validateLedgerObject({ schema: LEDGER_SCHEMA, schemaVersion: 2, records });
    atomicWrite(this.filePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  #withLock(operation) {
    ensurePrivateDirectory(this.directory);
    let descriptor;
    try {
      descriptor = fs.openSync(this.lockPath, "wx", 0o600);
      fs.writeFileSync(descriptor, `${process.pid}\n`, "utf8");
      fs.fsyncSync(descriptor);
      return operation();
    } catch (error) {
      if (error?.code === "EEXIST") throw new Error("receipt ledger is locked; fail closed and inspect the lock before retrying");
      throw error;
    } finally {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
        fs.unlinkSync(this.lockPath);
      }
    }
  }
}

export function validateLedgerObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== LEDGER_SCHEMA || value.schemaVersion !== 2) {
    throw new Error("recent ledger envelope is invalid");
  }
  if (!Array.isArray(value.records) || value.records.length > MAX_RECORDS) throw new Error("recent ledger must contain at most 100 records");
  return Object.freeze({ schema: LEDGER_SCHEMA, schemaVersion: 2, records: value.records.map(validateRecord) });
}

export function validateEvidenceText(text) {
  const lines = String(text).split("\n").filter((line) => line.trim());
  const entries = [];
  let previousHash = "0".repeat(64);
  for (let index = 0; index < lines.length; index += 1) {
    const entry = JSON.parse(lines[index]);
    if (entry.schema !== EVIDENCE_SCHEMA || entry.schemaVersion !== 2 || entry.sequence !== index + 1) {
      throw new Error(`evidence line ${index + 1} has an invalid envelope`);
    }
    assertDigest(entry.requestKey, "requestKey");
    assertDigest(entry.previousHash, "previousHash");
    assertDigest(entry.hash, "hash");
    if (entry.previousHash !== previousHash) throw new Error(`evidence line ${index + 1} breaks the hash chain`);
    validateEvidence(entry.evidence);
    const { hash, ...unsigned } = entry;
    if (digest(canonicalJson(unsigned)) !== hash) throw new Error(`evidence line ${index + 1} has an invalid hash`);
    previousHash = hash;
    entries.push(Object.freeze(entry));
  }
  return entries;
}

export function planLedgerMigration({ currentPath = defaultLedgerPath(), candidates = legacyLedgerPaths() } = {}) {
  const current = path.resolve(currentPath);
  if (fs.existsSync(current)) {
    assertPrivateFile(current);
    const records = validateLedgerObject(JSON.parse(fs.readFileSync(current, "utf8"))).records.length;
    return Object.freeze({ status: "current", currentPath: current, records });
  }
  const existing = candidates.map((item) => path.resolve(item)).filter((item) => fs.existsSync(item));
  if (existing.length === 0) return Object.freeze({ status: "none", currentPath: current });
  if (existing.length > 1) return Object.freeze({ status: "ambiguous", currentPath: current, legacyPaths: existing });
  const legacyPath = existing[0];
  assertPrivateFile(legacyPath);
  const text = fs.readFileSync(legacyPath, "utf8");
  try {
    const object = validateLedgerObject(JSON.parse(text));
    return Object.freeze({ status: "ready", format: "v2-ledger", currentPath: current, legacyPath, records: object.records.length });
  } catch {
    const requestKeys = validateLegacyV1Evidence(text).map((entry) => entry.requestKey);
    return Object.freeze({ status: "ready", format: "v1-evidence", currentPath: current, legacyPath, requestKeys });
  }
}

export function applyLedgerMigration(plan) {
  if (plan?.status !== "ready") throw new Error("only a reviewed ready migration plan can be applied");
  const currentPath = path.resolve(plan.currentPath);
  const legacyPath = path.resolve(plan.legacyPath);
  if (fs.existsSync(currentPath)) throw new Error("current ledger appeared after migration review");
  assertPrivateFile(legacyPath);
  ensurePrivateDirectory(path.dirname(currentPath));
  if (plan.format === "v2-ledger") {
    const object = validateLedgerObject(JSON.parse(fs.readFileSync(legacyPath, "utf8")));
    atomicWrite(currentPath, `${JSON.stringify(object, null, 2)}\n`);
  } else if (plan.format === "v1-evidence") {
    const entries = validateLegacyV1Evidence(fs.readFileSync(legacyPath, "utf8"));
    atomicWrite(currentPath, `${JSON.stringify({ schema: LEDGER_SCHEMA, schemaVersion: 2, records: [] }, null, 2)}\n`);
    const ledger = new ReceiptLedger(currentPath);
    const unique = [...new Set(entries.map((entry) => entry.requestKey))];
    let prior = [];
    for (const requestKey of unique) {
      prior.push(appendMigratedEvidence(ledger.evidencePath, prior, requestKey, legacyPath));
    }
  } else {
    throw new Error("unsupported ledger migration format");
  }
  assertPrivateFile(currentPath);
  validateLedgerObject(JSON.parse(fs.readFileSync(currentPath, "utf8")));
  return Object.freeze({ currentPath, legacyPath, preservedLegacy: true, format: plan.format });
}

function appendMigratedEvidence(evidencePath, entries, requestKey, legacyPath) {
  const previousHash = entries.at(-1)?.hash ?? "0".repeat(64);
  const unsigned = {
    schema: EVIDENCE_SCHEMA,
    schemaVersion: 2,
    sequence: entries.length + 1,
    at: new Date().toISOString(),
    requestKey,
    runId: "legacy-migration",
    transition: "legacy_claim_imported",
    evidence: { legacyPathHash: digest(legacyPath) },
    previousHash,
  };
  const entry = { ...unsigned, hash: digest(canonicalJson(unsigned)) };
  const descriptor = fs.openSync(evidencePath, "a", 0o600);
  try {
    fs.writeSync(descriptor, `${JSON.stringify(entry)}\n`, null, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(evidencePath, 0o600);
  return entry;
}

function validateLegacyV1Evidence(text) {
  const lines = String(text).split("\n").filter((line) => line.trim());
  const entries = [];
  let previousHash = "0".repeat(64);
  for (let index = 0; index < lines.length; index += 1) {
    const entry = JSON.parse(lines[index]);
    if (entry.schema !== LEDGER_SCHEMA || entry.schemaVersion !== 1 || entry.sequence !== index + 1) throw new Error("legacy ledger is invalid");
    assertDigest(entry.requestKey, "requestKey");
    if (entry.previousHash !== previousHash) throw new Error("legacy ledger hash chain is invalid");
    const { hash, ...unsigned } = entry;
    if (digest(canonicalJson(unsigned)) !== hash) throw new Error("legacy ledger hash is invalid");
    previousHash = hash;
    entries.push(entry);
  }
  return entries;
}

function validateRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ledger record is invalid");
  const record = {
    chat_guid: exact(value.chat_guid, "chat_guid", 256),
    message_ts: exact(value.message_ts, "message_ts", 256),
    vendor: value.vendor === null || value.vendor === undefined ? null : exact(value.vendor, "vendor", 80),
    outcome: exact(value.outcome, "outcome", 40),
    run_at: exact(value.run_at, "run_at", 64),
    request_hash: exact(value.request_hash, "request_hash", 64),
  };
  if (!OUTCOMES.has(record.outcome)) throw new Error("ledger record outcome is invalid");
  if (Number.isNaN(new Date(record.run_at).getTime())) throw new Error("ledger record run_at is invalid");
  assertDigest(record.request_hash, "request_hash");
  return Object.freeze(record);
}

function validateEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("evidence must be an object");
  const cleaned = {};
  for (const [key, item] of Object.entries(value)) {
    if (!ALLOWED_EVIDENCE_KEYS.has(key)) throw new Error(`evidence key '${key}' is not allowed`);
    if (!["string", "number", "boolean"].includes(typeof item) || (typeof item === "number" && !Number.isFinite(item))) {
      throw new Error(`evidence '${key}' must be a scalar`);
    }
    cleaned[key] = typeof item === "string" ? item.slice(0, 512) : item;
  }
  if (Buffer.byteLength(JSON.stringify(cleaned), "utf8") > 16 * 1024) throw new Error("evidence exceeds 16 KB");
  return cleaned;
}

function atomicWrite(target, text) {
  const directory = ensurePrivateDirectory(path.dirname(target));
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, text, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function exact(value, label, max) {
  const text = String(value ?? "").trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/u.test(text)) throw new Error(`${label} is invalid`);
  return text;
}

function assertDigest(value, label) {
  if (!/^[a-f0-9]{64}$/u.test(String(value ?? ""))) throw new Error(`${label} must be a SHA-256 digest`);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}
