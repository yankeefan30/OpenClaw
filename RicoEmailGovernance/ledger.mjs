import path from "node:path";
import {
  assertPrivateFile,
  createPrivateJsonExclusive,
  defaultStateDirectory,
  ensurePrivateDirectory,
  readPrivateJson,
  writePrivateJson,
} from "./private-store.mjs";

const ACTIONS = new Set([
  "person-email",
  "group-email",
  "group-meeting-handoff-email",
  "meeting-requester-reply",
  "meeting-handoff-email",
]);
const FINAL_STATUSES = new Set(["confirmed", "outcome-unknown"]);
const DIGEST = /^[a-f0-9]{64}$/u;

export class DeliveryLedger {
  constructor(directory = path.join(defaultStateDirectory(), "delivery-claims"), now = () => new Date()) {
    this.directory = ensurePrivateDirectory(path.resolve(directory));
    this.now = now;
  }

  reserve({ requestKey, action, evidence = {} }) {
    validateRequestKey(requestKey);
    validateAction(action);
    const at = this.timestamp();
    const record = validateRecord({
      schema: "rico.email-delivery-claim",
      schemaVersion: 1,
      requestKey,
      action,
      status: "reserved",
      reservedAt: at,
      completedAt: null,
      evidence: validateEvidence(evidence),
    });
    return createPrivateJsonExclusive(this.claimPath(requestKey, action), record);
  }

  complete({ requestKey, action, status, evidence = {} }) {
    validateRequestKey(requestKey);
    validateAction(action);
    if (!FINAL_STATUSES.has(status)) throw coded("ledger_final_status_invalid");
    const filePath = this.claimPath(requestKey, action);
    assertPrivateFile(filePath);
    const current = validateRecord(readPrivateJson(filePath));
    if (current.requestKey !== requestKey || current.action !== action) throw coded("ledger_claim_mismatch");
    if (current.status !== "reserved") return current;
    const completed = validateRecord({
      ...current,
      status,
      completedAt: this.timestamp(),
      evidence: { ...current.evidence, ...validateEvidence(evidence) },
    });
    writePrivateJson(filePath, completed, { replace: true });
    return completed;
  }

  read({ requestKey, action }) {
    validateRequestKey(requestKey);
    validateAction(action);
    const filePath = this.claimPath(requestKey, action);
    try {
      return validateRecord(readPrivateJson(filePath));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  claimPath(requestKey, action) {
    validateRequestKey(requestKey);
    validateAction(action);
    return path.join(this.directory, `${requestKey}.${action}.json`);
  }

  timestamp() {
    const value = this.now();
    const timestamp = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(timestamp.getTime())) throw coded("ledger_clock_invalid");
    return timestamp.toISOString();
  }
}

function validateRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw coded("ledger_record_invalid");
  const expected = ["schema", "schemaVersion", "requestKey", "action", "status", "reservedAt", "completedAt", "evidence"].sort();
  if (Object.keys(value).sort().join(",") !== expected.join(",")) throw coded("ledger_record_fields_invalid");
  if (value.schema !== "rico.email-delivery-claim" || value.schemaVersion !== 1) throw coded("ledger_record_schema_invalid");
  validateRequestKey(value.requestKey);
  validateAction(value.action);
  if (!["reserved", ...FINAL_STATUSES].includes(value.status)) throw coded("ledger_record_status_invalid");
  if (!Number.isFinite(Date.parse(value.reservedAt))) throw coded("ledger_reserved_at_invalid");
  if (value.status === "reserved" && value.completedAt !== null) throw coded("ledger_completed_at_invalid");
  if (value.status !== "reserved" && !Number.isFinite(Date.parse(value.completedAt))) throw coded("ledger_completed_at_invalid");
  validateEvidence(value.evidence);
  return Object.freeze(value);
}

function validateEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw coded("ledger_evidence_invalid");
  const cleaned = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(key)) throw coded("ledger_evidence_key_invalid");
    if (typeof item !== "string" && typeof item !== "boolean" && typeof item !== "number") throw coded("ledger_evidence_value_invalid");
    if (typeof item === "number" && !Number.isFinite(item)) throw coded("ledger_evidence_value_invalid");
    cleaned[key] = typeof item === "string" ? item.slice(0, 512) : item;
  }
  if (Buffer.byteLength(JSON.stringify(cleaned), "utf8") > 16 * 1024) throw coded("ledger_evidence_too_large");
  return cleaned;
}

function validateRequestKey(value) {
  if (!DIGEST.test(String(value ?? ""))) throw coded("ledger_request_key_invalid");
}

function validateAction(value) {
  if (!ACTIONS.has(value)) throw coded("ledger_action_invalid");
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
