import fs from "node:fs";
import path from "node:path";
import { canonicalJson, randomChallenge, randomId, sha256 } from "./canonical.mjs";
import { governed } from "./errors.mjs";
import { normalizeInboundMessageBody } from "./invocation-proof.mjs";
import { appendPrivateJsonLine, ensurePrivateDirectory, readPrivateJson, safeRecordPath, writePrivateJson } from "./private-store.mjs";

const KINDS = new Set(["booking-preview", "booking-hold", "cancel-preview", "reservation"]);
const CHALLENGE_PREFIX = Object.freeze({
  "booking-preview": "HOLD",
  "booking-hold": "BOOK",
  "cancel-preview": "CANCEL",
});

export class OpenTableStateStore {
  constructor(directory, now = () => new Date()) {
    this.directory = ensurePrivateDirectory(path.resolve(directory));
    this.now = now;
    for (const child of ["booking-preview", "booking-hold", "cancel-preview", "reservation", "claims"]) {
      ensurePrivateDirectory(path.join(this.directory, child));
    }
  }

  createChallenge(kind, { payload, principal, ttlMs }) {
    if (!CHALLENGE_PREFIX[kind]) throw governed("challenge_kind_invalid", "The OpenTable challenge type is invalid.");
    const createdAt = this.timestamp();
    const expiresAt = new Date(new Date(createdAt).getTime() + ttlMs).toISOString();
    const id = randomId();
    const record = {
      schema: "openclaw.opentable.challenge",
      version: 1,
      id,
      kind,
      status: "active",
      createdAt,
      expiresAt,
      consumedAt: null,
      challenge: randomChallenge(CHALLENGE_PREFIX[kind]),
      payloadDigest: sha256(payload),
      principalBinding: principal.bindingDigest,
      sourceMessageDigest: principal.messageDigest,
      sourceRunDigest: principal.runDigest,
      payload,
    };
    writePrivateJson(this.recordPath(kind, id), record, { exclusive: true });
    this.event("challenge.created", { kind, id, payloadDigest: record.payloadDigest, principalBinding: record.principalBinding });
    return freeze(record);
  }

  read(kind, id) {
    this.assertKind(kind);
    return freeze(validateRecord(readPrivateJson(this.recordPath(kind, id)), kind));
  }

  requireActive(kind, id, { confirmation, principal }) {
    const record = this.read(kind, id);
    if (record.status !== "active") throw governed("challenge_consumed", "This OpenTable confirmation challenge has already been used.");
    if (new Date(record.expiresAt) <= this.date()) throw governed("challenge_expired", "This OpenTable confirmation challenge has expired.");
    if (record.principalBinding !== principal.bindingDigest) throw governed("challenge_principal_mismatch", "This OpenTable challenge belongs to a different iMessage principal or conversation.");
    if (record.sourceMessageDigest === principal.messageDigest) throw governed("confirmation_message_reused", "A new authenticated inbound iMessage is required for this confirmation.");
    if (record.sourceRunDigest === principal.runDigest) throw governed("same_run_chaining_blocked", "OpenTable confirmations cannot chain inside the same agent run.");
    if (principal.messageBodyDigest !== sha256(normalizeInboundMessageBody(record.challenge))) {
      throw governed("inbound_message_challenge_mismatch", `The entire inbound iMessage body must be exactly: ${record.challenge}`);
    }
    if (confirmation !== record.challenge) throw governed("confirmation_mismatch", `Explicit confirmation is required: ${record.challenge}`);
    if (sha256(record.payload) !== record.payloadDigest) throw governed("challenge_tampered", "The immutable OpenTable preview failed integrity verification.");
    return record;
  }

  consume(record) {
    const current = this.read(record.kind, record.id);
    if (current.status !== "active") return current;
    const consumed = { ...current, status: "consumed", consumedAt: this.timestamp() };
    writePrivateJson(this.recordPath(current.kind, current.id), consumed);
    this.event("challenge.consumed", { kind: current.kind, id: current.id, payloadDigest: current.payloadDigest });
    return freeze(consumed);
  }

  createReservation(payload) {
    const id = randomId();
    const record = {
      schema: "openclaw.opentable.reservation",
      version: 1,
      id,
      kind: "reservation",
      status: "confirmed",
      createdAt: this.timestamp(),
      updatedAt: this.timestamp(),
      payload,
    };
    writePrivateJson(this.recordPath("reservation", id), record, { exclusive: true });
    this.event("reservation.confirmed", safeReservationEvidence(record));
    return freeze(record);
  }

  updateReservation(id, status, evidence = {}) {
    const record = this.readReservation(id);
    const updated = { ...record, status, updatedAt: this.timestamp(), payload: { ...record.payload, ...evidence } };
    writePrivateJson(this.recordPath("reservation", id), updated);
    this.event(`reservation.${status}`, safeReservationEvidence(updated));
    return freeze(updated);
  }

  readReservation(id) {
    const value = readPrivateJson(this.recordPath("reservation", id));
    if (value?.schema !== "openclaw.opentable.reservation" || value.version !== 1 || value.kind !== "reservation" || value.id !== id) {
      throw governed("reservation_record_invalid", "The local OpenTable reservation record is invalid.");
    }
    return freeze(value);
  }

  listReservations({ limit = 20 } = {}) {
    const directory = path.join(this.directory, "reservation");
    const names = fs.readdirSync(directory).filter((name) => /^[a-f0-9-]{36}\.json$/u.test(name));
    return names.map((name) => this.readReservation(name.slice(0, -5)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  reserveMutation(action, entityId) {
    if (!/^(slot-lock|book|cancel|slot-release)$/u.test(action)) throw governed("mutation_action_invalid", "The OpenTable mutation action is invalid.");
    const key = sha256({ action, entityId });
    const filePath = path.join(this.directory, "claims", `${key}.json`);
    const claim = {
      schema: "openclaw.opentable.mutation-claim",
      version: 1,
      key,
      action,
      entityId,
      requestId: randomId(),
      status: "reserved",
      reservedAt: this.timestamp(),
      completedAt: null,
      evidence: {},
    };
    try {
      writePrivateJson(filePath, claim, { exclusive: true });
      this.event("mutation.reserved", { action, entityId, requestId: claim.requestId });
      return freeze({ ...claim, newlyReserved: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      return freeze({ ...readPrivateJson(filePath), newlyReserved: false });
    }
  }

  completeMutation(claim, status, evidence = {}) {
    if (!["confirmed", "failed", "outcome-unknown"].includes(status)) throw governed("mutation_status_invalid", "The OpenTable mutation outcome is invalid.");
    const filePath = path.join(this.directory, "claims", `${claim.key}.json`);
    const current = readPrivateJson(filePath);
    if (current.status !== "reserved") return freeze(current);
    const complete = { ...current, status, completedAt: this.timestamp(), evidence };
    writePrivateJson(filePath, complete);
    this.event(`mutation.${status}`, { action: current.action, entityId: current.entityId, requestId: current.requestId });
    return freeze(complete);
  }

  event(type, evidence) {
    appendPrivateJsonLine(path.join(this.directory, "ledger.jsonl"), {
      schema: "openclaw.opentable.ledger-event",
      version: 1,
      at: this.timestamp(),
      type,
      evidence,
    });
  }

  recordPath(kind, id) {
    this.assertKind(kind);
    return safeRecordPath(path.join(this.directory, kind), id);
  }

  assertKind(kind) {
    if (!KINDS.has(kind)) throw governed("record_kind_invalid", "The OpenTable record type is invalid.");
  }

  date() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw governed("clock_invalid", "The OpenTable governance clock is invalid.");
    return date;
  }

  timestamp() { return this.date().toISOString(); }
}

function validateRecord(value, kind) {
  if (!value || value.schema !== "openclaw.opentable.challenge" || value.version !== 1 || value.kind !== kind || !["active", "consumed"].includes(value.status)) {
    throw governed("challenge_record_invalid", "The OpenTable confirmation record is invalid.");
  }
  if (!Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.expiresAt))) throw governed("challenge_record_invalid", "The OpenTable confirmation record has invalid timestamps.");
  if (![value.payloadDigest, value.principalBinding, value.sourceMessageDigest, value.sourceRunDigest].every((item) => /^[a-f0-9]{64}$/u.test(String(item ?? "")))) {
    throw governed("challenge_record_invalid", "The OpenTable confirmation record has invalid identity bindings.");
  }
  return value;
}

function safeReservationEvidence(record) {
  return {
    id: record.id,
    status: record.status,
    rid: Number(record.payload.rid),
    confirmationNumber: String(record.payload.confirmationNumber ?? "").slice(0, 64),
    dateTime: String(record.payload.dateTime ?? "").slice(0, 32),
    partySize: Number(record.payload.partySize),
  };
}

function freeze(value) {
  return Object.freeze(value);
}
