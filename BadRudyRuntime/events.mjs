import fs from "node:fs";
import crypto from "node:crypto";
import { appendPrivateJsonLine, assertPrivateFile } from "./security.mjs";
import { codedError } from "./errors.mjs";

const EVENT_TYPES = new Set([
  "capture.completed",
  "delivery.would_send",
  "delivery.sent",
  "delivery.unknown",
  "schedule.queued",
  "schedule.awaiting_fire_confirmation",
  "schedule.cancelled",
  "runtime.blocked",
]);

export class BadRudyEventLog {
  constructor(filePath, { now = () => new Date() } = {}) {
    this.filePath = filePath;
    this.now = now;
  }

  write(type, data) {
    if (!EVENT_TYPES.has(type)) throw codedError("event_type_invalid", "Bad Rudy refused an unknown log event.");
    const event = Object.freeze({
      schema: "openclaw.bad-rudy-event/v1",
      id: cryptoRandomUUID(),
      type,
      at: this.now().toISOString(),
      data: sanitizeEventData(data),
    });
    appendPrivateJsonLine(this.filePath, event);
    return event;
  }

  recent(limit = 20) {
    if (!fs.existsSync(this.filePath)) return [];
    assertPrivateFile(this.filePath);
    const count = Math.max(0, Math.min(500, Number(limit) || 20));
    const lines = fs.readFileSync(this.filePath, "utf8").split(/\r?\n/u).filter(Boolean);
    return lines.slice(-count).reverse().map((line) => {
      try {
        const event = JSON.parse(line);
        if (event?.schema !== "openclaw.bad-rudy-event/v1" || !EVENT_TYPES.has(event.type)) throw new Error("invalid event");
        return event;
      } catch (error) {
        throw codedError("event_log_invalid", "Bad Rudy's local event log is invalid.", error);
      }
    });
  }
}

function sanitizeEventData(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  // Rebuild from JSON-compatible metadata. Credentials are never accepted by
  // this interface, and credential-shaped keys are rejected recursively.
  return sanitizeValue(input, 0);
}

function sanitizeValue(value, depth) {
  if (depth > 6) throw codedError("event_data_invalid", "Bad Rudy refused overly nested event metadata.");
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 4_000);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value !== "object") throw codedError("event_data_invalid", "Bad Rudy refused non-JSON event metadata.");
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(?:credential|cookie|token|password|secret|authorization)/iu.test(key)) throw codedError("credential_log_blocked", "Bad Rudy refused credential-shaped log data.");
    result[key] = sanitizeValue(item, depth + 1);
  }
  return result;
}

function cryptoRandomUUID() {
  return crypto.randomUUID();
}
