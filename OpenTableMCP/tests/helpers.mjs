import crypto from "node:crypto";
import { canonicalJson, sha256 } from "../canonical.mjs";
import { normalizeInboundMessageBody, signInvocationProof } from "../invocation-proof.mjs";

export const FIXED_NOW = new Date("2026-08-15T16:00:00.000Z");
export const HMAC_KEY = Buffer.alloc(32, 7).toString("base64");

export function validBundle(overrides = {}) {
  const base = {
    schema: "openclaw.opentable.partner-credentials",
    version: 1,
    enabled: true,
    environment: "production",
    apiFamily: "consumer-v2",
    clientId: "reviewed-client-id",
    clientSecret: "reviewed-client-secret",
    apiBaseUrl: "https://platform.opentable.com",
    oauthBaseUrl: "https://oauth.opentable.com",
    invocationHmacKey: HMAC_KEY,
    diner: {
      firstName: "Alan",
      lastName: "Rosa",
      email: "alan@example.com",
      phone: { countryCode: "US", number: "+16465550123", type: "Mobile" },
    },
    approval: {
      partnerApproved: true,
      appReviewed: true,
      agreementReference: "OT-AGREEMENT-123",
      contractDocumentSha256: "a".repeat(64),
      approvedCapabilities: ["directory", "availability", "booking_policy", "cancellation_policy", "slot_lock", "book", "get_reservation", "cancel"],
      approvedInterface: "consumer-visual-imessage",
      approvedAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2027-08-01T00:00:00.000Z",
    },
  };
  return merge(base, overrides);
}

export class BufferCredentialProvider {
  constructor(bundle = validBundle()) {
    this.bundle = bundle;
    this.calls = 0;
  }

  async status() { return { available: true, service: "openclaw-opentable", account: "alan" }; }

  async withSecret(operation) {
    this.calls += 1;
    const buffer = Buffer.from(canonicalJson(this.bundle), "utf8");
    try { return await operation(buffer); } finally { buffer.fill(0); }
  }
}

export function proof(action, { now = FIXED_NOW, principal = "alan-owner", conversation = "chat-1", message = crypto.randomUUID(), messageBody = "owner request", run = crypto.randomUUID(), expiresInMs = 120_000 } = {}) {
  const issuedAt = new Date(now);
  return signInvocationProof({
    schema: "openclaw.opentable.invocation",
    version: 1,
    audience: "openclaw-opentable-mcp",
    issuer: "rico-recipient-guard",
    guardContract: "rico-recipient-guard/v5",
    injectionMode: "before_tool_call_overwrite",
    principalDigest: sha256(principal),
    principalRole: "owner",
    channel: "imessage",
    messageDigest: sha256(message),
    messageBodyDigest: sha256(normalizeInboundMessageBody(messageBody)),
    conversationDigest: sha256(conversation),
    runDigest: sha256(run),
    allowedActions: [action],
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + expiresInMs).toISOString(),
    nonce: crypto.randomBytes(18).toString("base64url"),
  }, HMAC_KEY);
}

export function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { "content-type": "application/json", ...headers } });
}

export function emptyResponse({ status = 200, headers = {} } = {}) {
  return new Response(null, { status, headers });
}

function merge(base, overrides) {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(overrides)) {
    if (value && typeof value === "object" && !Array.isArray(value) && result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) result[key] = merge(result[key], value);
    else result[key] = value;
  }
  return result;
}
