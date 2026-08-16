import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDirectory, writePrivateJson } from "./grant.mjs";

const SCHEMA = "rico.ists-any-group-state";
const VERSION = 1;
const MAX_SEEN = 20_000;
const MAX_OUTBOX = 5_000;
const FOLLOWUP_WINDOW_MS = 15 * 60 * 1_000;

export class AnyGroupIngressStateStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    ensurePrivateDirectory(path.dirname(this.filePath));
  }

  load() {
    if (!fs.existsSync(this.filePath)) return emptyState();
    const stat = fs.lstatSync(this.filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
      throw coded("any_group_state_file_invalid");
    }
    return validateState(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
  }

  baseline({ groups, seenEventHashes, at }) {
    const state = this.load();
    if (state.initializedAt !== null) throw coded("any_group_already_initialized");
    state.initializedAt = iso(at, "any_group_baseline_time_invalid");
    for (const group of groups) state.groups[group.groupKey] = cursorRecord(group.cursorAt, at);
    appendSeen(state, seenEventHashes, at);
    this.#save(state);
  }

  cursorFor(groupKey) {
    const state = this.load();
    return state.groups[digest(groupKey, "any_group_key_invalid")]?.cursorAt ?? state.initializedAt;
  }

  hasSeen(eventHash) {
    const value = digest(eventHash, "any_group_event_hash_invalid");
    return this.load().seen.some((entry) => entry.eventHash === value);
  }

  followupEligible({ groupKey, senderHash, at }) {
    const state = this.load();
    const record = state.followups[digest(groupKey, "any_group_key_invalid")];
    return Boolean(record
      && record.senderHash === digest(senderHash, "any_group_sender_hash_invalid")
      && Date.parse(iso(at, "any_group_followup_time_invalid")) - Date.parse(record.at) <= FOLLOWUP_WINDOW_MS
      && Date.parse(iso(at, "any_group_followup_time_invalid")) >= Date.parse(record.at));
  }

  reserve({ eventHash, outboxKey, payloadHash, groupKey, senderHash, queryKind, at }) {
    const state = this.load();
    const event = digest(eventHash, "any_group_event_hash_invalid");
    const outbox = digest(outboxKey, "any_group_outbox_key_invalid");
    if (state.seen.some((entry) => entry.eventHash === event)) throw coded("any_group_event_already_seen");
    if (state.outbox.some((entry) => entry.outboxKey === outbox)) throw coded("any_group_outbox_exists");
    appendSeen(state, [event], at);
    state.outbox.push({
      outboxKey: outbox,
      payloadHash: digest(payloadHash, "any_group_payload_hash_invalid"),
      groupKey: digest(groupKey, "any_group_key_invalid"),
      senderHash: digest(senderHash, "any_group_sender_hash_invalid"),
      queryKind: kind(queryKind),
      state: "reserved",
      reservedAt: iso(at, "any_group_reservation_time_invalid"),
      completedAt: null,
      outcomeCode: null,
      acknowledgementHash: null,
    });
    trim(state);
    this.#save(state);
  }

  complete({ outboxKey, outcomeCode, acknowledgementHash = null, at }) {
    const state = this.load();
    const record = exactOutbox(state, outboxKey);
    if (record.state !== "reserved") throw coded("any_group_outbox_already_final");
    record.state = outcomeCode === "delivered" ? "delivered" : "outcome-unknown";
    record.outcomeCode = safeCode(outcomeCode);
    record.acknowledgementHash = acknowledgementHash === null
      ? null
      : digest(acknowledgementHash, "any_group_ack_hash_invalid");
    record.completedAt = iso(at, "any_group_completion_time_invalid");
    if (record.state === "delivered") {
      state.followups[record.groupKey] = { senderHash: record.senderHash, at: record.completedAt };
    }
    this.#save(state);
  }

  markSeen({ groupKey, cursorAt, eventHashes, at }) {
    const state = this.load();
    const key = digest(groupKey, "any_group_key_invalid");
    state.groups[key] = cursorRecord(cursorAt, at);
    appendSeen(state, eventHashes, at);
    trim(state);
    this.#save(state);
  }

  unresolvedReservations() {
    return this.load().outbox.filter((entry) => entry.state === "reserved").map((entry) => entry.outboxKey);
  }

  #save(state) {
    writePrivateJson(this.filePath, validateState(state));
  }
}

function emptyState() {
  return {
    schema: SCHEMA,
    schemaVersion: VERSION,
    initializedAt: null,
    groups: {},
    seen: [],
    followups: {},
    outbox: [],
  };
}

function validateState(value) {
  exactKeys(value, ["schema", "schemaVersion", "initializedAt", "groups", "seen", "followups", "outbox"]);
  if (value.schema !== SCHEMA || value.schemaVersion !== VERSION) throw coded("any_group_state_schema_invalid");
  const state = emptyState();
  state.initializedAt = value.initializedAt === null ? null : iso(value.initializedAt, "any_group_initialized_at_invalid");
  if (!plainObject(value.groups) || Object.keys(value.groups).length > 10_000) throw coded("any_group_state_groups_invalid");
  for (const [groupKey, record] of Object.entries(value.groups)) {
    digest(groupKey, "any_group_key_invalid");
    exactKeys(record, ["cursorAt", "updatedAt"]);
    state.groups[groupKey] = {
      cursorAt: nullableISO(record.cursorAt, "any_group_cursor_invalid"),
      updatedAt: iso(record.updatedAt, "any_group_cursor_update_invalid"),
    };
  }
  if (!Array.isArray(value.seen) || value.seen.length > MAX_SEEN) throw coded("any_group_seen_invalid");
  state.seen = value.seen.map((entry) => {
    exactKeys(entry, ["eventHash", "seenAt"]);
    return { eventHash: digest(entry.eventHash, "any_group_event_hash_invalid"), seenAt: iso(entry.seenAt, "any_group_seen_at_invalid") };
  });
  if (new Set(state.seen.map((entry) => entry.eventHash)).size !== state.seen.length) throw coded("any_group_seen_duplicate");
  if (!plainObject(value.followups) || Object.keys(value.followups).length > 10_000) throw coded("any_group_followups_invalid");
  for (const [groupKey, record] of Object.entries(value.followups)) {
    digest(groupKey, "any_group_key_invalid");
    exactKeys(record, ["senderHash", "at"]);
    state.followups[groupKey] = {
      senderHash: digest(record.senderHash, "any_group_sender_hash_invalid"),
      at: iso(record.at, "any_group_followup_record_time_invalid"),
    };
  }
  if (!Array.isArray(value.outbox) || value.outbox.length > MAX_OUTBOX) throw coded("any_group_outbox_invalid");
  state.outbox = value.outbox.map(validateOutbox);
  if (new Set(state.outbox.map((entry) => entry.outboxKey)).size !== state.outbox.length) throw coded("any_group_outbox_duplicate");
  return state;
}

function validateOutbox(record) {
  exactKeys(record, [
    "outboxKey", "payloadHash", "groupKey", "senderHash", "queryKind", "state",
    "reservedAt", "completedAt", "outcomeCode", "acknowledgementHash",
  ]);
  const state = String(record.state);
  if (!new Set(["reserved", "delivered", "outcome-unknown"]).has(state)) throw coded("any_group_outbox_state_invalid");
  if (state === "reserved" && (record.completedAt !== null || record.outcomeCode !== null || record.acknowledgementHash !== null)) {
    throw coded("any_group_outbox_reservation_invalid");
  }
  if (state !== "reserved" && (record.completedAt === null || record.outcomeCode === null)) {
    throw coded("any_group_outbox_completion_invalid");
  }
  return {
    outboxKey: digest(record.outboxKey, "any_group_outbox_key_invalid"),
    payloadHash: digest(record.payloadHash, "any_group_payload_hash_invalid"),
    groupKey: digest(record.groupKey, "any_group_key_invalid"),
    senderHash: digest(record.senderHash, "any_group_sender_hash_invalid"),
    queryKind: kind(record.queryKind),
    state,
    reservedAt: iso(record.reservedAt, "any_group_reservation_time_invalid"),
    completedAt: nullableISO(record.completedAt, "any_group_completion_time_invalid"),
    outcomeCode: record.outcomeCode === null ? null : safeCode(record.outcomeCode),
    acknowledgementHash: record.acknowledgementHash === null ? null : digest(record.acknowledgementHash, "any_group_ack_hash_invalid"),
  };
}

function exactOutbox(state, outboxKey) {
  const key = digest(outboxKey, "any_group_outbox_key_invalid");
  const matches = state.outbox.filter((entry) => entry.outboxKey === key);
  if (matches.length !== 1) throw coded("any_group_outbox_missing");
  return matches[0];
}

function appendSeen(state, values, at) {
  const seenAt = iso(at, "any_group_seen_at_invalid");
  const existing = new Set(state.seen.map((entry) => entry.eventHash));
  for (const value of values) {
    const eventHash = digest(value, "any_group_event_hash_invalid");
    if (!existing.has(eventHash)) {
      state.seen.push({ eventHash, seenAt });
      existing.add(eventHash);
    }
  }
}

function cursorRecord(cursorAt, updatedAt) {
  return { cursorAt: nullableISO(cursorAt, "any_group_cursor_invalid"), updatedAt: iso(updatedAt, "any_group_cursor_update_invalid") };
}

function trim(state) {
  state.seen = state.seen.slice(-MAX_SEEN);
  state.outbox = state.outbox.slice(-MAX_OUTBOX);
  const cutoff = Date.now() - 24 * 60 * 60 * 1_000;
  for (const [key, record] of Object.entries(state.followups)) {
    if (Date.parse(record.at) < cutoff) delete state.followups[key];
  }
}

function digest(value, code) {
  const text = String(value ?? "");
  if (!/^[a-f0-9]{64}$/u.test(text)) throw coded(code);
  return text;
}

function kind(value) {
  const text = String(value ?? "");
  if (!new Set(["status", "resolution", "timing", "impact"]).has(text)) throw coded("any_group_query_kind_invalid");
  return text;
}

function iso(value, code) {
  const date = new Date(String(value ?? ""));
  if (!Number.isFinite(date.getTime())) throw coded(code);
  return date.toISOString();
}

function nullableISO(value, code) {
  return value === null ? null : iso(value, code);
}

function safeCode(value) {
  const code = String(value ?? "").toLowerCase().replace(/[^a-z0-9_-]+/gu, "_").slice(0, 80);
  if (!code) throw coded("any_group_outcome_code_invalid");
  return code;
}

function exactKeys(value, keys) {
  if (!plainObject(value)) throw coded("any_group_state_shape_invalid");
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) throw coded("any_group_state_fields_invalid");
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
