import { createHash } from "node:crypto";

export const WORKFLOW_TIMEZONE = "America/New_York";
export const WINDOW_START_MINUTE = 5 * 60 + 30;
export const WINDOW_END_MINUTE = 23 * 60 + 59;
export const GENERIC_LOCATIONS = Object.freeze(["Genius Scan", "Alan Gmail", "CVS Outlook"]);

const CAPABILITY_KEYS = Object.freeze([
  "openCaseSession",
  "heygenSession",
  "geniusScan",
  "alanGmail",
  "cvsOutlook",
]);

export class WorkflowPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkflowPolicyError";
    this.code = code;
  }
}

export function normalizeHandle(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  for (const prefix of ["imessage:", "sms:", "tel:", "mailto:"]) {
    if (lower.startsWith(prefix)) return normalizeHandle(raw.slice(prefix.length));
  }
  if (raw.includes("@")) return normalizeEmail(raw);
  const digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+")) return digits ? `+${digits}` : "";
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
}

export function normalizeEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) return "";
  return email;
}

export function normalizeHttpsOrigin(value) {
  try {
    const url = new URL(String(value ?? ""));
    if (url.protocol !== "https:" || url.username || url.password) return "";
    return url.origin;
  } catch {
    return "";
  }
}

export function validatePermissionGrant(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkflowPolicyError("grant_invalid", "Permission grant must be an object.");
  }
  if (value.schemaVersion !== 2) {
    throw new WorkflowPolicyError("grant_version", "Permission grant schemaVersion must be 2.");
  }
  const janetHandle = normalizeHandle(value.janetHandle);
  const janetEmailRecipient = normalizeEmail(value.janetEmailRecipient);
  const alanGmailSender = normalizeEmail(value.alanGmailSender);
  const openCaseOrigin = normalizeHttpsOrigin(value.openCaseOrigin);
  const heygenOrigin = normalizeHttpsOrigin(value.heygenOrigin);
  if (!janetHandle) throw new WorkflowPolicyError("grant_janet", "Permission grant needs one exact Janet iMessage handle.");
  if (!janetEmailRecipient) throw new WorkflowPolicyError("grant_recipient", "Permission grant needs one exact Janet email recipient.");
  if (!alanGmailSender) throw new WorkflowPolicyError("grant_sender", "Permission grant needs Alan's exact Gmail send-as address.");
  if (!openCaseOrigin) throw new WorkflowPolicyError("grant_opencase", "Permission grant needs the exact OpenCase HTTPS origin.");
  if (!heygenOrigin) throw new WorkflowPolicyError("grant_heygen", "Permission grant needs the exact Heygen HTTPS origin.");

  if (!value.capabilityRefs || typeof value.capabilityRefs !== "object" || Array.isArray(value.capabilityRefs)) {
    throw new WorkflowPolicyError("grant_capabilities", "Permission grant needs exact private capability references.");
  }
  const capabilityRefs = {};
  for (const key of CAPABILITY_KEYS) {
    const reference = String(value.capabilityRefs[key] ?? "").trim();
    if (!/^(?:browser-session|mcp|oauth-profile|private-ref):[A-Za-z0-9._:-]{1,100}$/u.test(reference)) {
      throw new WorkflowPolicyError("grant_capability_ref", `Capability reference '${key}' is invalid.`);
    }
    capabilityRefs[key] = reference;
  }
  if (Object.keys(value.capabilityRefs).some((key) => !CAPABILITY_KEYS.includes(key))) {
    throw new WorkflowPolicyError("grant_capability_extra", "Permission grant has an unsupported capability reference.");
  }

  return deepFreeze({
    schemaVersion: 2,
    janetHandle,
    janetEmailRecipient,
    alanGmailSender,
    openCaseOrigin,
    heygenOrigin,
    capabilityRefs,
  });
}

export function easternMinuteOfDay(date) {
  const instant = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(instant.getTime())) throw new WorkflowPolicyError("time_invalid", "Execution time is invalid.");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: WORKFLOW_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new WorkflowPolicyError("time_unavailable", "Eastern time could not be resolved.");
  }
  return (hour % 24) * 60 + minute;
}

export function isWithinEasternWindow(date) {
  const minute = easternMinuteOfDay(date);
  return minute >= WINDOW_START_MINUTE && minute <= WINDOW_END_MINUTE;
}

export function parseInboundRequest(event, grantInput, now = new Date()) {
  const grant = validatePermissionGrant(grantInput);
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new WorkflowPolicyError("event_invalid", "Inbound event must be one object.");
  }
  if (String(event.channel ?? "").trim().toLowerCase() !== "imessage") {
    throw new WorkflowPolicyError("channel_mismatch", "Only iMessage events are eligible.");
  }
  if (event.isGroup === true) throw new WorkflowPolicyError("group_denied", "This workflow accepts direct messages only.");
  if (event.isFromMe === true || String(event.direction ?? "in").toLowerCase() === "out") {
    throw new WorkflowPolicyError("direction_denied", "Only inbound messages are eligible.");
  }
  const senderHandle = normalizeHandle(event.senderHandle ?? event.senderId ?? event.from);
  if (!senderHandle || senderHandle !== grant.janetHandle) {
    throw new WorkflowPolicyError("sender_mismatch", "Sender is not the exact granted Janet handle.");
  }

  const content = String(event.content ?? event.body ?? "").trim();
  if (!content || content.length > 500 || /[\r\n]/u.test(content)) {
    throw new WorkflowPolicyError("content_invalid", "Request must be one non-empty line no longer than 500 characters.");
  }
  const invocation = /^@?(rico|polar)(?=$|[\s,:;.!?\-])(?:[\s,:;.!?\-]+)?(.*)$/iu.exec(content);
  if (!invocation) throw new WorkflowPolicyError("alias_mismatch", "Request must begin with the exact Rico or Polar alias.");
  const requestText = String(invocation[2] ?? "").trim();
  if (!requestText || !/\breceipts?\b/iu.test(requestText)) {
    throw new WorkflowPolicyError("receipt_request_missing", "Request must ask for one receipt.");
  }

  const chatGuid = exactSourceField(event.chatGuid ?? event.chat_guid ?? event.conversationId ?? event.metadata?.chat_guid, "chat_guid");
  const messageTs = exactSourceField(event.messageTs ?? event.message_ts ?? event.timestamp, "message_ts");
  const executionAt = now instanceof Date ? now : new Date(now);
  if (!isWithinEasternWindow(executionAt)) {
    throw new WorkflowPolicyError("outside_window", "Request is outside the 05:30-23:59 America/New_York window.");
  }

  const vendorHint = extractVendorHint(requestText);
  const amountHint = extractAmountHint(requestText);
  const dateHint = extractDateHint(requestText);
  const route = routeForVendor(vendorHint);
  const alias = invocation[1].toLowerCase();
  const requestKey = sha256([chatGuid, messageTs, senderHandle, content].join("\u0000"));
  return deepFreeze({
    alias,
    requestText,
    requestKey,
    chatGuid,
    messageTs,
    vendorHint,
    amountHint,
    dateHint,
    route,
    locations: locationsForRoute(route),
    senderFingerprint: sha256(senderHandle),
    senderHandle,
    runAt: executionAt.toISOString(),
  });
}

export function routeForVendor(vendor) {
  const canonical = String(vendor ?? "").toLowerCase().replace(/[^a-z0-9]/gu, "");
  if (canonical === "opencase") return "opencase";
  if (canonical === "heygen") return "heygen";
  return "general";
}

export function locationsForRoute(route) {
  if (route === "opencase") return Object.freeze(["OpenCase portal"]);
  if (route === "heygen") return Object.freeze(["Heygen portal"]);
  return GENERIC_LOCATIONS;
}

export function safeVendor(value) {
  const vendor = String(value ?? "").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9&.' -]{0,79}$/u.test(vendor) || /(?:system|assistant|developer)\s*:/iu.test(vendor)) return null;
  return vendor;
}

export function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function extractVendorHint(text) {
  if (/\bopen\s*case\b/iu.test(text)) return "OpenCase";
  if (/\bheygen\b/iu.test(text)) return "Heygen";
  const from = /\breceipt\s+(?:from|for)\s+([A-Za-z0-9][A-Za-z0-9&.' -]{0,79}?)(?=\s+(?:for|on|dated|amount|\$|in\s+[A-Z][a-z]+\s+\d{4})\b|$)/iu.exec(text);
  return safeVendor(from?.[1]);
}

function extractAmountHint(text) {
  const match = /(?:\bUSD\s*)?\$\s*\d{1,7}(?:,\d{3})*(?:\.\d{2})?/iu.exec(text);
  return match ? match[0].replace(/\s+/gu, " ").trim() : null;
}

function extractDateHint(text) {
  const iso = /\b\d{4}-\d{2}-\d{2}\b/u.exec(text)?.[0];
  if (iso) return iso;
  return /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(?:\d{1,2},\s*)?\d{4}\b/iu.exec(text)?.[0] ?? null;
}

function exactSourceField(value, label) {
  const result = String(value ?? "").trim();
  if (!result || result.length > 256 || /[\u0000-\u001f\u007f]/u.test(result)) {
    throw new WorkflowPolicyError(`${label}_missing`, `Original ${label} is required for exact ledger identity.`);
  }
  return result;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
