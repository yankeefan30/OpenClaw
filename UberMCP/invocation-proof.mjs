import crypto from "node:crypto";
import { canonicalJson, sha256 } from "./canonical.mjs";
import { governed } from "./errors.mjs";

const PROOF_KEYS = [
  "schema", "version", "audience", "issuer", "guardContract", "injectionMode",
  "principalDigest", "principalRole", "channel", "messageIdDigest", "messageBodyDigest",
  "conversationDigest", "runIdDigest", "action", "argsDigest", "toolCallIdDigest",
  "issuedAt", "expiresAt", "nonce",
];
const DIGEST = /^[a-f0-9]{64}$/u;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/u;

export function verifyInvocationProof(token, hmacKeyBase64, { action, args }, now = new Date()) {
  if (typeof token !== "string" || token.length < 80 || token.length > 8192) {
    throw governed("invocation_proof_missing", "A guard-injected short-lived owner iMessage proof is required.");
  }
  const pieces = token.split(".");
  if (pieces.length !== 2) throw governed("invocation_proof_invalid", "The Uber invocation proof is invalid.");
  const [encoded, signature] = pieces;
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch {
    throw governed("invocation_proof_invalid", "The Uber invocation proof is invalid.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).sort().join() !== [...PROOF_KEYS].sort().join()) {
    throw governed("invocation_proof_invalid", "The Uber invocation proof contract is invalid.");
  }
  const expected = crypto.createHmac("sha256", Buffer.from(hmacKeyBase64, "base64")).update(encoded).digest();
  let supplied;
  try { supplied = Buffer.from(signature, "base64url"); } catch { supplied = Buffer.alloc(0); }
  const matches = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  expected.fill(0);
  supplied.fill(0);
  if (!matches) throw governed("invocation_proof_invalid", "The Uber invocation proof signature is invalid.");

  if (payload.schema !== "openclaw.uber.invocation" || payload.version !== 2 || payload.audience !== "openclaw-uber-mcp"
    || payload.issuer !== "rico-recipient-guard" || payload.guardContract !== "rico-recipient-guard/v5"
    || payload.injectionMode !== "before_tool_call_overwrite") {
    throw governed("invocation_proof_invalid", "The invocation proof is not intended for the governed Uber server.");
  }
  if (payload.principalRole !== "owner" || payload.channel !== "imessage") {
    throw governed("principal_not_authorized", "Only Alan's authenticated iMessage identity may operate Uber ride actions.");
  }
  if (![payload.principalDigest, payload.messageIdDigest, payload.messageBodyDigest, payload.conversationDigest,
    payload.runIdDigest, payload.argsDigest, payload.toolCallIdDigest].every((item) => DIGEST.test(String(item ?? "")))) {
    throw governed("invocation_proof_invalid", "The Uber invocation proof binding is invalid.");
  }
  if (payload.action !== action) throw governed("action_not_authorized", "This iMessage turn is not authorized for that exact Uber action.");
  if (payload.argsDigest !== sha256(normalizeToolArguments(args))) {
    throw governed("invocation_args_mismatch", "The guard-issued Uber proof does not match the complete tool arguments.");
  }
  if (!NONCE.test(String(payload.nonce ?? ""))) throw governed("invocation_proof_invalid", "The Uber invocation proof nonce is invalid.");
  const issuedAt = new Date(payload.issuedAt);
  const expiresAt = new Date(payload.expiresAt);
  const clock = now instanceof Date ? now : new Date(now);
  if (![issuedAt, expiresAt, clock].every((item) => Number.isFinite(item.getTime())) || issuedAt.getTime() > clock.getTime() + 15_000
    || expiresAt <= clock || expiresAt.getTime() - issuedAt.getTime() > 120_000) {
    throw governed("invocation_proof_expired", "The owner iMessage invocation proof has expired.");
  }
  return Object.freeze({
    principalDigest: payload.principalDigest,
    messageIdDigest: payload.messageIdDigest,
    messageBodyDigest: payload.messageBodyDigest,
    conversationDigest: payload.conversationDigest,
    runIdDigest: payload.runIdDigest,
    action: payload.action,
    argsDigest: payload.argsDigest,
    toolCallIdDigest: payload.toolCallIdDigest,
    nonceDigest: sha256(payload.nonce),
    expiresAt: expiresAt.toISOString(),
    bindingDigest: sha256({ principalDigest: payload.principalDigest, conversationDigest: payload.conversationDigest }),
  });
}

export function normalizeInboundMessageBody(value) {
  if (typeof value !== "string" || value.length > 4096 || /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw governed("inbound_message_body_invalid", "The authenticated iMessage body is invalid.");
  }
  return value.normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
}

export function normalizeToolArguments(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw governed("tool_arguments_invalid", "The Uber tool arguments are invalid.");
  const clean = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "invocation_proof") continue;
    if (["__proto__", "constructor", "prototype"].includes(key)) throw governed("tool_arguments_invalid", "The Uber tool arguments contain an unsafe key.");
    clean[key] = item;
  }
  return clean;
}

/** Test/integration seam; production issuance is InvocationProofIssuerV5. */
export function signInvocationProof(payload, hmacKeyBase64) {
  const encoded = Buffer.from(canonicalJson(payload), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", Buffer.from(hmacKeyBase64, "base64")).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}
