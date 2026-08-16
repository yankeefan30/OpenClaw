import fs from "node:fs";
import path from "node:path";
import { assertPrivateFile, canonicalJson, ensurePrivateDirectory, sha256, writePrivateJson } from "./grant.mjs";

const STATE_SCHEMA = "rico.ists-incident-state";
const AUDIT_SCHEMA = "rico.ists-incident-audit";
const ZERO_HASH = "0".repeat(64);
// Records are never evicted: eviction could permit a replay after a cursor
// reset. Reaching a high defensive capacity blocks the workflow instead.
const MAX_MESSAGES = 1_000_000;
const MAX_INCIDENTS = 100_000;
const MAX_OUTBOX = 100_000;
const MAX_RESEARCH = 100_000;
const MESSAGE_STATUSES = new Set(["baseline", "suppressed-cooldown", "reserved", "delivered", "outcome-unknown"]);
const OUTBOX_STATUSES = new Set(["reserved", "delivered", "outcome-unknown"]);
const RESEARCH_STATUSES = new Set(["reserved", "accepted", "failed"]);

export class IncidentStateStore {
  constructor(statePath, auditPath = path.join(path.dirname(path.resolve(statePath)), "audit.jsonl")) {
    this.statePath = path.resolve(statePath);
    this.auditPath = path.resolve(auditPath);
    this.directory = path.dirname(this.statePath);
    if (path.dirname(this.auditPath) !== this.directory) throw coded("state_audit_directory_mismatch");
    this.lockPath = path.join(this.directory, ".state.lock");
    ensurePrivateDirectory(this.directory);
  }

  load() {
    const stateExists = fs.existsSync(this.statePath);
    const auditExists = fs.existsSync(this.auditPath);
    if (!stateExists) {
      if (auditExists) {
        assertPrivateFile(this.auditPath);
        if (fs.readFileSync(this.auditPath, "utf8").trim()) throw coded("audit_without_state");
      }
      return initialState();
    }
    assertPrivateFile(this.statePath);
    const state = validateState(JSON.parse(fs.readFileSync(this.statePath, "utf8")));
    const audit = auditExists ? readAudit(this.auditPath) : [];
    const head = audit.at(-1)?.hash ?? ZERO_HASH;
    if (state.auditSequence !== audit.length || state.auditHead !== head) throw coded("state_audit_head_mismatch");
    return state;
  }

  isSeen(identityHash) {
    assertDigest(identityHash, "message_identity_hash_invalid");
    return this.load().messages.some((item) => item.identityHash === identityHash);
  }

  unresolvedReservations() {
    return this.load().outbox.filter((item) => item.status === "reserved");
  }

  isIncidentInCooldown(incidentFingerprint, at, cooldownSeconds) {
    assertDigest(incidentFingerprint, "incident_fingerprint_invalid");
    const now = new Date(at);
    if (!Number.isFinite(now.getTime())) throw coded("cooldown_time_invalid");
    const incident = this.load().incidents.find((item) => item.incidentFingerprint === incidentFingerprint);
    return Boolean(incident && now.getTime() - Date.parse(incident.lastAttemptAt) < cooldownSeconds * 1_000);
  }

  baseline({ identityHashes, cursor, at }) {
    return this.#transaction("baseline_created", {
      count: identityHashes.length,
      cursorHash: sha256(cursor),
    }, (state) => {
      if (state.initializedAt !== null) throw coded("baseline_already_exists");
      const timestamp = isoDate(at, "baseline_time_invalid");
      state.initializedAt = timestamp;
      state.cursor = validateCursor(cursor);
      for (const identityHash of uniqueDigests(identityHashes, "message_identity_hash_invalid")) {
        upsertMessage(state, { identityHash, status: "baseline", at: timestamp, incidentFingerprint: null, outboxKey: null });
      }
      assertCapacity(state);
    });
  }

  advanceCursor({ cursor, at, eventType = "empty_poll" }) {
    return this.#transaction(eventType, { cursorHash: sha256(cursor) }, (state) => {
      if (state.initializedAt === null) throw coded("baseline_missing");
      isoDate(at, "cursor_time_invalid");
      state.cursor = validateCursor(cursor);
    });
  }

  recordLateBaseline({ identityHashes, cursor, at }) {
    return this.#transaction("late_baseline_observed", {
      count: identityHashes.length,
      cursorHash: sha256(cursor),
    }, (state) => {
      const timestamp = isoDate(at, "late_baseline_time_invalid");
      for (const identityHash of uniqueDigests(identityHashes, "message_identity_hash_invalid")) {
        upsertMessage(state, { identityHash, status: "baseline", at: timestamp, incidentFingerprint: null, outboxKey: null });
      }
      state.cursor = validateCursor(cursor);
      assertCapacity(state);
    });
  }

  suppressCooldown({ identityHashes, incidentFingerprint, cursor, at }) {
    return this.#transaction("incident_suppressed_cooldown", {
      count: identityHashes.length,
      incidentFingerprint,
      cursorHash: sha256(cursor),
    }, (state) => {
      const timestamp = isoDate(at, "suppression_time_invalid");
      assertDigest(incidentFingerprint, "incident_fingerprint_invalid");
      for (const identityHash of uniqueDigests(identityHashes, "message_identity_hash_invalid")) {
        upsertMessage(state, { identityHash, status: "suppressed-cooldown", at: timestamp, incidentFingerprint, outboxKey: null });
      }
      state.cursor = validateCursor(cursor);
      assertCapacity(state);
    });
  }

  reserveDelivery({ identityHashes, incidentFingerprint, outboxKey, payloadHash, idempotencyKey, sourceRef, at }) {
    return this.#transaction("delivery_reserved", {
      count: identityHashes.length,
      incidentFingerprint,
      outboxKey,
      payloadHash,
      sourceRef,
    }, (state) => {
      const timestamp = isoDate(at, "reservation_time_invalid");
      for (const digest of [incidentFingerprint, outboxKey, payloadHash, sourceRef]) assertDigest(digest, "reservation_digest_invalid");
      if (!/^rico:ists:[a-f0-9]{64}$/u.test(String(idempotencyKey ?? ""))) throw coded("idempotency_key_invalid");
      if (state.outbox.some((item) => item.outboxKey === outboxKey || item.idempotencyKey === idempotencyKey)) throw coded("outbox_already_reserved");
      for (const identityHash of uniqueDigests(identityHashes, "message_identity_hash_invalid")) {
        if (state.messages.some((item) => item.identityHash === identityHash)) throw coded("message_already_seen");
        state.messages.push({ identityHash, status: "reserved", at: timestamp, incidentFingerprint, outboxKey });
      }
      const priorIncident = state.incidents.find((item) => item.incidentFingerprint === incidentFingerprint);
      const nextIncident = {
        incidentFingerprint,
        lastAttemptAt: timestamp,
        lastSentAt: priorIncident?.lastSentAt ?? null,
        status: "reserved",
        outboxKey,
      };
      if (priorIncident) Object.assign(priorIncident, nextIncident);
      else state.incidents.push(nextIncident);
      state.outbox.push({
        outboxKey,
        payloadHash,
        idempotencyKey,
        sourceRef,
        status: "reserved",
        reservedAt: timestamp,
        deliveryAck: null,
      });
      assertCapacity(state);
    });
  }

  acknowledgeDelivery({ outboxKey, transportMessageId, guardDecisionId, cursor, at }) {
    return this.#transaction("delivery_acknowledged", {
      outboxKey,
      transportMessageHash: sha256(transportMessageId),
      guardDecisionHash: sha256(guardDecisionId),
      cursorHash: sha256(cursor),
    }, (state) => {
      const timestamp = isoDate(at, "delivery_ack_time_invalid");
      assertDigest(outboxKey, "outbox_key_invalid");
      const outbox = state.outbox.find((item) => item.outboxKey === outboxKey);
      if (!outbox || outbox.status !== "reserved") throw coded("outbox_not_reserved");
      outbox.status = "delivered";
      outbox.deliveryAck = {
        at: timestamp,
        transportMessageHash: sha256(bounded(transportMessageId, 1, 4_096, "transport_message_id_invalid")),
        guardDecisionHash: sha256(bounded(guardDecisionId, 1, 512, "guard_decision_id_invalid")),
      };
      for (const message of state.messages.filter((item) => item.outboxKey === outboxKey)) {
        message.status = "delivered";
        message.at = timestamp;
      }
      const incident = state.incidents.find((item) => item.outboxKey === outboxKey);
      if (!incident) throw coded("reserved_incident_missing");
      incident.status = "delivered";
      incident.lastSentAt = timestamp;
      state.cursor = validateCursor(cursor);
    });
  }

  quarantineDelivery({ outboxKey, cursor, errorCode, at }) {
    return this.#transaction("delivery_outcome_unknown", {
      outboxKey,
      cursorHash: sha256(cursor),
      errorCode: safeCode(errorCode),
    }, (state) => {
      const timestamp = isoDate(at, "delivery_unknown_time_invalid");
      assertDigest(outboxKey, "outbox_key_invalid");
      const outbox = state.outbox.find((item) => item.outboxKey === outboxKey);
      if (!outbox || outbox.status !== "reserved") throw coded("outbox_not_reserved");
      outbox.status = "outcome-unknown";
      for (const message of state.messages.filter((item) => item.outboxKey === outboxKey)) {
        message.status = "outcome-unknown";
        message.at = timestamp;
      }
      const incident = state.incidents.find((item) => item.outboxKey === outboxKey);
      if (incident) incident.status = "outcome-unknown";
      state.cursor = validateCursor(cursor);
    });
  }

  reserveResearch({ sourceRef, incidentFingerprint, at }) {
    return this.#transaction("research_reserved", { sourceRef, incidentFingerprint }, (state) => {
      const timestamp = isoDate(at, "research_reservation_time_invalid");
      assertDigest(sourceRef, "source_ref_invalid");
      assertDigest(incidentFingerprint, "incident_fingerprint_invalid");
      if (state.research.some((item) => item.sourceRef === sourceRef)) throw coded("research_already_reserved");
      state.research.push({ sourceRef, incidentFingerprint, status: "reserved", at: timestamp, handoffHash: null, errorCode: null });
      assertCapacity(state);
    });
  }

  completeResearch({ sourceRef, handoffId, at }) {
    return this.#transaction("research_accepted", { sourceRef, handoffHash: sha256(handoffId) }, (state) => {
      const item = researchItem(state, sourceRef, "reserved");
      item.status = "accepted";
      item.at = isoDate(at, "research_completion_time_invalid");
      item.handoffHash = sha256(bounded(handoffId, 1, 4_096, "research_handoff_id_invalid"));
    });
  }

  failResearch({ sourceRef, errorCode, at }) {
    return this.#transaction("research_failed", { sourceRef, errorCode: safeCode(errorCode) }, (state) => {
      const item = researchItem(state, sourceRef, "reserved");
      item.status = "failed";
      item.at = isoDate(at, "research_failure_time_invalid");
      item.errorCode = safeCode(errorCode);
    });
  }

  #transaction(type, data, mutation) {
    ensurePrivateDirectory(this.directory);
    let descriptor;
    try {
      descriptor = fs.openSync(this.lockPath, "wx", 0o600);
      fs.writeFileSync(descriptor, `${process.pid}\n`, "utf8");
      fs.fsyncSync(descriptor);
      const current = this.load();
      const next = structuredClone(current);
      mutation(next);
      const event = makeAuditEvent(current, type, data);
      appendAudit(this.auditPath, event);
      next.auditSequence = event.sequence;
      next.auditHead = event.hash;
      validateState(next);
      writePrivateJson(this.statePath, next);
      return next;
    } catch (error) {
      if (error?.code === "EEXIST") throw coded("state_locked");
      throw error;
    } finally {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
        fs.unlinkSync(this.lockPath);
      }
    }
  }
}

export function initialState() {
  return {
    schema: STATE_SCHEMA,
    schemaVersion: 1,
    initializedAt: null,
    cursor: null,
    auditSequence: 0,
    auditHead: ZERO_HASH,
    messages: [],
    incidents: [],
    outbox: [],
    research: [],
  };
}

export function readAudit(filePath) {
  if (!fs.existsSync(filePath)) return [];
  assertPrivateFile(filePath);
  const lines = fs.readFileSync(filePath, "utf8").split("\n").filter((line) => line.trim());
  const output = [];
  let previousHash = ZERO_HASH;
  for (let index = 0; index < lines.length; index += 1) {
    const entry = JSON.parse(lines[index]);
    exactKeys(entry, ["schema", "schemaVersion", "sequence", "at", "type", "data", "previousHash", "hash"], "audit entry");
    if (entry.schema !== AUDIT_SCHEMA || entry.schemaVersion !== 1 || entry.sequence !== index + 1 || entry.previousHash !== previousHash) {
      throw coded("audit_chain_invalid");
    }
    isoDate(entry.at, "audit_time_invalid");
    bounded(entry.type, 1, 80, "audit_type_invalid");
    assertDigest(entry.previousHash, "audit_previous_hash_invalid");
    assertDigest(entry.hash, "audit_hash_invalid");
    validateAuditData(entry.data);
    const { hash, ...unsigned } = entry;
    if (sha256(canonicalJson(unsigned)) !== hash) throw coded("audit_hash_mismatch");
    previousHash = hash;
    output.push(Object.freeze(entry));
  }
  return output;
}

function makeAuditEvent(state, type, data) {
  const at = new Date().toISOString();
  const cleanData = validateAuditData(data);
  const unsigned = {
    schema: AUDIT_SCHEMA,
    schemaVersion: 1,
    sequence: state.auditSequence + 1,
    at,
    type: bounded(type, 1, 80, "audit_type_invalid"),
    data: cleanData,
    previousHash: state.auditHead,
  };
  return Object.freeze({ ...unsigned, hash: sha256(canonicalJson(unsigned)) });
}

function appendAudit(filePath, event) {
  const descriptor = fs.openSync(filePath, "a", 0o600);
  try {
    fs.writeSync(descriptor, `${JSON.stringify(event)}\n`, null, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(filePath, 0o600);
}

function validateState(input) {
  exactKeys(input, [
    "schema",
    "schemaVersion",
    "initializedAt",
    "cursor",
    "auditSequence",
    "auditHead",
    "messages",
    "incidents",
    "outbox",
    "research",
  ], "state");
  if (input.schema !== STATE_SCHEMA || input.schemaVersion !== 1) throw coded("state_schema_invalid");
  if (input.initializedAt !== null) isoDate(input.initializedAt, "state_initialized_at_invalid");
  if (input.cursor !== null) validateCursor(input.cursor);
  if (!Number.isInteger(input.auditSequence) || input.auditSequence < 0) throw coded("state_audit_sequence_invalid");
  assertDigest(input.auditHead, "state_audit_head_invalid");
  if (!Array.isArray(input.messages) || input.messages.length > MAX_MESSAGES) throw coded("state_messages_invalid");
  if (!Array.isArray(input.incidents) || input.incidents.length > MAX_INCIDENTS) throw coded("state_incidents_invalid");
  if (!Array.isArray(input.outbox) || input.outbox.length > MAX_OUTBOX) throw coded("state_outbox_invalid");
  if (!Array.isArray(input.research) || input.research.length > MAX_RESEARCH) throw coded("state_research_invalid");
  uniqueBy(input.messages, "identityHash", validateMessageRecord, "state_message_duplicate");
  uniqueBy(input.incidents, "incidentFingerprint", validateIncidentRecord, "state_incident_duplicate");
  uniqueBy(input.outbox, "outboxKey", validateOutboxRecord, "state_outbox_duplicate");
  uniqueBy(input.research, "sourceRef", validateResearchRecord, "state_research_duplicate");
  const outboxKeys = new Set(input.outbox.map((item) => item.outboxKey));
  const idempotencyKeys = new Set();
  for (const item of input.outbox) {
    if (idempotencyKeys.has(item.idempotencyKey)) throw coded("state_outbox_idempotency_duplicate");
    idempotencyKeys.add(item.idempotencyKey);
  }
  for (const item of input.messages) {
    if (item.outboxKey !== null && !outboxKeys.has(item.outboxKey)) throw coded("state_message_outbox_missing");
  }
  for (const item of input.incidents) if (!outboxKeys.has(item.outboxKey)) throw coded("state_incident_outbox_missing");
  return input;
}

function validateMessageRecord(input) {
  exactKeys(input, ["identityHash", "status", "at", "incidentFingerprint", "outboxKey"], "message record");
  assertDigest(input.identityHash, "message_identity_hash_invalid");
  if (!MESSAGE_STATUSES.has(input.status)) throw coded("message_status_invalid");
  isoDate(input.at, "message_time_invalid");
  if (input.incidentFingerprint !== null) assertDigest(input.incidentFingerprint, "message_incident_fingerprint_invalid");
  if (input.outboxKey !== null) assertDigest(input.outboxKey, "message_outbox_key_invalid");
}

function validateIncidentRecord(input) {
  exactKeys(input, ["incidentFingerprint", "lastAttemptAt", "lastSentAt", "status", "outboxKey"], "incident record");
  assertDigest(input.incidentFingerprint, "incident_fingerprint_invalid");
  isoDate(input.lastAttemptAt, "incident_attempt_time_invalid");
  if (input.lastSentAt !== null) isoDate(input.lastSentAt, "incident_sent_time_invalid");
  if (!OUTBOX_STATUSES.has(input.status)) throw coded("incident_status_invalid");
  assertDigest(input.outboxKey, "incident_outbox_key_invalid");
}

function validateOutboxRecord(input) {
  exactKeys(input, ["outboxKey", "payloadHash", "idempotencyKey", "sourceRef", "status", "reservedAt", "deliveryAck"], "outbox record");
  for (const value of [input.outboxKey, input.payloadHash, input.sourceRef]) assertDigest(value, "outbox_digest_invalid");
  if (!/^rico:ists:[a-f0-9]{64}$/u.test(input.idempotencyKey)) throw coded("outbox_idempotency_invalid");
  if (!OUTBOX_STATUSES.has(input.status)) throw coded("outbox_status_invalid");
  isoDate(input.reservedAt, "outbox_reserved_at_invalid");
  if (input.status === "delivered") {
    exactKeys(input.deliveryAck, ["at", "transportMessageHash", "guardDecisionHash"], "delivery ack");
    isoDate(input.deliveryAck.at, "delivery_ack_time_invalid");
    assertDigest(input.deliveryAck.transportMessageHash, "delivery_transport_hash_invalid");
    assertDigest(input.deliveryAck.guardDecisionHash, "delivery_guard_hash_invalid");
  } else if (input.deliveryAck !== null) throw coded("delivery_ack_unexpected");
}

function validateResearchRecord(input) {
  exactKeys(input, ["sourceRef", "incidentFingerprint", "status", "at", "handoffHash", "errorCode"], "research record");
  assertDigest(input.sourceRef, "research_source_ref_invalid");
  assertDigest(input.incidentFingerprint, "research_incident_fingerprint_invalid");
  if (!RESEARCH_STATUSES.has(input.status)) throw coded("research_status_invalid");
  isoDate(input.at, "research_time_invalid");
  if (input.status === "accepted") assertDigest(input.handoffHash, "research_handoff_hash_invalid");
  else if (input.handoffHash !== null) throw coded("research_handoff_hash_unexpected");
  if (input.status === "failed") {
    if (typeof input.errorCode !== "string" || safeCode(input.errorCode) !== input.errorCode) throw coded("research_error_invalid");
  }
  else if (input.errorCode !== null) throw coded("research_error_unexpected");
}

function validateAuditData(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw coded("audit_data_invalid");
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (!/^[a-z][A-Za-z0-9]{0,63}$/u.test(key) || /(?:text|summary|cursor$|messageid|handle|email|phone)/iu.test(key)) {
      throw coded("audit_data_key_forbidden");
    }
    if (!(value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
      || (typeof value === "string" && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value)))) {
      throw coded("audit_data_value_invalid");
    }
    output[key] = value;
  }
  return output;
}

function upsertMessage(state, record) {
  validateMessageRecord(record);
  const existing = state.messages.find((item) => item.identityHash === record.identityHash);
  if (existing) Object.assign(existing, record);
  else state.messages.push(record);
}

function researchItem(state, sourceRef, expectedStatus) {
  assertDigest(sourceRef, "research_source_ref_invalid");
  const item = state.research.find((entry) => entry.sourceRef === sourceRef);
  if (!item || item.status !== expectedStatus) throw coded("research_not_reserved");
  return item;
}

function assertCapacity(state) {
  if (state.messages.length > MAX_MESSAGES || state.incidents.length > MAX_INCIDENTS
    || state.outbox.length > MAX_OUTBOX || state.research.length > MAX_RESEARCH) {
    throw coded("state_capacity_exhausted");
  }
}

function uniqueDigests(values, code) {
  if (!Array.isArray(values) || values.length > 1_000) throw coded(code);
  for (const value of values) assertDigest(value, code);
  return [...new Set(values)];
}

function uniqueBy(items, key, validator, code) {
  const seen = new Set();
  for (const item of items) {
    validator(item);
    if (seen.has(item[key])) throw coded(code);
    seen.add(item[key]);
  }
}

function validateCursor(value) {
  if (typeof value !== "string" || !value || value.length > 16_384 || /[\u0000]/u.test(value)) throw coded("cursor_invalid");
  return value;
}

function bounded(value, minimum, maximum, code) {
  const normalized = String(value ?? "").trim();
  if (normalized.length < minimum || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) throw coded(code);
  return normalized;
}

function isoDate(value, code) {
  const date = new Date(String(value ?? ""));
  if (!Number.isFinite(date.getTime())) throw coded(code);
  return date.toISOString();
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw coded(`${label.replaceAll(" ", "_")}_invalid`);
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) throw coded(`${label.replaceAll(" ", "_")}_fields_invalid`);
}

function assertDigest(value, code) {
  if (!/^[a-f0-9]{64}$/u.test(String(value ?? ""))) throw coded(code);
}

function safeCode(value) {
  const normalized = String(value ?? "unknown").toLowerCase().replace(/[^a-z0-9_-]+/gu, "_").slice(0, 80);
  if (!normalized) throw coded("error_code_invalid");
  return normalized;
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
