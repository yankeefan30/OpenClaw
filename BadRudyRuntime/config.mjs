import fs from "node:fs";
import path from "node:path";
import { atomicWritePrivateJson, assertPrivateDirectoryChain, ensurePrivateDirectoryChain, readPrivateJson } from "./security.mjs";
import { codedError } from "./errors.mjs";

export const CONFIG_SCHEMA = "openclaw.bad-rudy-config/v1";
export const REQUIRED_GATEWAY_CONTRACT = "rico-reviewed-attachment/v1";
export const REQUIRED_WORKER_CAPABILITY = "grok:companions:bad-rudy";
export const NEW_YORK_TIME_ZONE = "America/New_York";

export function defaultConfig() {
  return Object.freeze({
    schema: CONFIG_SCHEMA,
    schemaVersion: 1,
    // A missing configuration is deliberately doubly safe: an operator must
    // turn off the kill switch, and the first enabled run still remains dry.
    killSwitch: true,
    dryRun: true,
    allowedRecipients: [],
    maxDurationSeconds: 20,
    maxRetries: 1,
    stillFrameDefault: true,
    scheduler: {
      timeZone: NEW_YORK_TIME_ZONE,
      minLeadSeconds: 120,
      maxLeadSeconds: 30 * 24 * 60 * 60,
    },
    rateLimits: {
      globalCapturesPerHour: 6,
      perRecipientSendsPerHour: 3,
    },
    reviewedGateway: {
      method: "rico.imessage.sendReviewedAttachment",
      contractVersion: REQUIRED_GATEWAY_CONTRACT,
    },
  });
}

export function validateConfig(input) {
  const value = requireRecord(input, "configuration");
  if (value.schema !== CONFIG_SCHEMA || value.schemaVersion !== 1) throw codedError("config_schema_unsupported", "Bad Rudy's configuration schema is unsupported.");
  if (typeof value.killSwitch !== "boolean" || typeof value.dryRun !== "boolean") throw codedError("config_invalid", "Bad Rudy's safety switches are invalid.");
  const allowedRecipients = [...new Set(requireArray(value.allowedRecipients, "allowedRecipients").map(normalizeRecipient))];
  const scheduler = requireRecord(value.scheduler, "scheduler");
  if (scheduler.timeZone !== NEW_YORK_TIME_ZONE) throw codedError("scheduler_timezone_invalid", "Bad Rudy scheduling is restricted to America/New_York.");
  const minLeadSeconds = boundedInteger(scheduler.minLeadSeconds, 120, 86_400, "scheduler.minLeadSeconds");
  const maxLeadSeconds = boundedInteger(scheduler.maxLeadSeconds, minLeadSeconds, 30 * 24 * 60 * 60, "scheduler.maxLeadSeconds");
  const rateLimits = requireRecord(value.rateLimits, "rateLimits");
  const reviewedGateway = requireRecord(value.reviewedGateway, "reviewedGateway");
  if (reviewedGateway.method !== "rico.imessage.sendReviewedAttachment" || reviewedGateway.contractVersion !== REQUIRED_GATEWAY_CONTRACT) {
    throw codedError("reviewed_gateway_contract_invalid", "Bad Rudy requires Rico's reviewed attachment delivery contract.");
  }
  return Object.freeze({
    schema: CONFIG_SCHEMA,
    schemaVersion: 1,
    killSwitch: value.killSwitch,
    dryRun: value.dryRun,
    allowedRecipients: Object.freeze(allowedRecipients),
    maxDurationSeconds: boundedInteger(value.maxDurationSeconds, 1, 20, "maxDurationSeconds"),
    maxRetries: boundedInteger(value.maxRetries, 0, 2, "maxRetries"),
    stillFrameDefault: value.stillFrameDefault === true,
    scheduler: Object.freeze({ timeZone: NEW_YORK_TIME_ZONE, minLeadSeconds, maxLeadSeconds }),
    rateLimits: Object.freeze({
      globalCapturesPerHour: boundedInteger(rateLimits.globalCapturesPerHour, 1, 60, "globalCapturesPerHour"),
      perRecipientSendsPerHour: boundedInteger(rateLimits.perRecipientSendsPerHour, 1, 30, "perRecipientSendsPerHour"),
    }),
    reviewedGateway: Object.freeze({ ...reviewedGateway }),
  });
}

export class BadRudyConfigStore {
  constructor(filePath, { privateAnchor = null } = {}) {
    this.filePath = filePath;
    this.privateAnchor = privateAnchor;
  }

  exists() {
    return fs.existsSync(this.filePath);
  }

  read() {
    if (this.privateAnchor && fs.existsSync(this.filePath)) assertPrivateDirectoryChain(this.privateAnchor, path.dirname(this.filePath));
    return validateConfig(readPrivateJson(this.filePath, defaultConfig()));
  }

  write(value) {
    const validated = validateConfig(value);
    if (this.privateAnchor) ensurePrivateDirectoryChain(this.privateAnchor, path.dirname(this.filePath));
    // Every change, including the first materialization of a config supplied
    // by an installer, is atomic. Existing configs receive a timestamped
    // sibling backup before replacement.
    atomicWritePrivateJson(this.filePath, validated, { backup: fs.existsSync(this.filePath) });
    return validated;
  }
}

export function normalizeRecipient(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw codedError("recipient_invalid", "A recipient from Rico's allowlist is required.");
  if (raw.includes("@")) {
    const value = raw.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value) || value.length > 254) throw codedError("recipient_invalid", "The allowlisted recipient is invalid.");
    return value;
  }
  const digits = raw.replace(/\D/gu, "");
  if (raw.startsWith("+") && /^\+[1-9]\d{7,14}$/u.test(`+${digits}`)) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  throw codedError("recipient_invalid", "The allowlisted recipient is invalid.");
}

function boundedInteger(input, minimum, maximum, label) {
  const value = Number(input);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw codedError("config_invalid", `${label} must be an integer from ${minimum} through ${maximum}.`);
  return value;
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw codedError("config_invalid", `${label} must be an object.`);
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw codedError("config_invalid", `${label} must be an array.`);
  return value;
}
