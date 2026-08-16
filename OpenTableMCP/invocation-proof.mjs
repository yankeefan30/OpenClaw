import crypto from "node:crypto";
import { canonicalJson, sha256 } from "./canonical.mjs";
import { governed } from "./errors.mjs";

const PROOF_KEYS = [
  "schema", "version", "audience", "issuer", "guardContract", "injectionMode",
  "principalDigest", "principalRole", "channel", "messageDigest", "messageBodyDigest",
  "conversationDigest", "runDigest", "allowedActions", "issuedAt", "expiresAt", "nonce",
];
const DIGEST = /^[a-f0-9]{64}$/u;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/u;

export function verifyInvocationProof(token, hmacKeyBase64, action, now = new Date()) {
  if (typeof token !== "string" || token.length < 80 || token.length > 8192) {
    throw governed("invocation_proof_missing", "A short-lived owner iMessage invocation proof is required.");
  }
  const pieces = token.split(".");
  if (pieces.length !== 2) throw governed("invocation_proof_invalid", "The iMessage invocation proof is invalid.");
  const [encoded, signature] = pieces;
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch {
    throw governed("invocation_proof_invalid", "The iMessage invocation proof is invalid.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).sort().join() !== [...PROOF_KEYS].sort().join()) {
    throw governed("invocation_proof_invalid", "The iMessage invocation proof has an invalid contract.");
  }
  const expected = crypto.createHmac("sha256", Buffer.from(hmacKeyBase64, "base64")).update(encoded).digest();
  let supplied;
  try { supplied = Buffer.from(signature, "base64url"); } catch { supplied = Buffer.alloc(0); }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    expected.fill(0); supplied.fill(0);
    throw governed("invocation_proof_invalid", "The iMessage invocation proof signature is invalid.");
  }
  expected.fill(0); supplied.fill(0);

  if (payload.schema !== "openclaw.opentable.invocation" || payload.version !== 1 || payload.audience !== "openclaw-opentable-mcp" || payload.issuer !== "rico-recipient-guard"
    || payload.guardContract !== "rico-recipient-guard/v5" || payload.injectionMode !== "before_tool_call_overwrite") {
    throw governed("invocation_proof_invalid", "The iMessage invocation proof is not intended for this server.");
  }
  if (payload.principalRole !== "owner" || payload.channel !== "imessage") {
    throw governed("principal_not_authorized", "Only Alan's authenticated iMessage identity may operate OpenTable reservations.");
  }
  if (![payload.principalDigest, payload.messageDigest, payload.messageBodyDigest, payload.conversationDigest, payload.runDigest].every((item) => DIGEST.test(String(item ?? "")))) {
    throw governed("invocation_proof_invalid", "The iMessage invocation proof identity binding is invalid.");
  }
  if (!Array.isArray(payload.allowedActions) || payload.allowedActions.length === 0 || payload.allowedActions.some((item) => typeof item !== "string" || item.length > 80)) {
    throw governed("invocation_proof_invalid", "The iMessage invocation proof action scope is invalid.");
  }
  if (!payload.allowedActions.includes(action)) throw governed("action_not_authorized", "This iMessage turn is not authorized for the requested OpenTable action.");
  if (!NONCE.test(String(payload.nonce ?? ""))) throw governed("invocation_proof_invalid", "The iMessage invocation proof nonce is invalid.");
  const issuedAt = new Date(payload.issuedAt);
  const expiresAt = new Date(payload.expiresAt);
  const clock = now instanceof Date ? now : new Date(now);
  if (![issuedAt, expiresAt, clock].every((item) => Number.isFinite(item.getTime())) || issuedAt.getTime() > clock.getTime() + 15_000 || expiresAt <= clock || expiresAt.getTime() - issuedAt.getTime() > 180_000) {
    throw governed("invocation_proof_expired", "The owner iMessage invocation proof has expired.");
  }
  return Object.freeze({
    principalDigest: payload.principalDigest,
    messageDigest: payload.messageDigest,
    messageBodyDigest: payload.messageBodyDigest,
    conversationDigest: payload.conversationDigest,
    runDigest: payload.runDigest,
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

/** Test/integration seam. Production callers must load the key from Keychain. */
export function signInvocationProof(payload, hmacKeyBase64) {
  const encoded = Buffer.from(canonicalJson(payload), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", Buffer.from(hmacKeyBase64, "base64")).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}
