import crypto from "node:crypto";
import { exactObject, sha256 } from "./canonical.mjs";
import { parseCredentialBundle } from "./credentials.mjs";
import { governed } from "./errors.mjs";
import { normalizeInboundMessageBody, signInvocationProof } from "./invocation-proof.mjs";

const ACTIONS = new Set([
  "restaurant.search", "availability.search", "booking.preview", "booking.hold", "booking.confirm",
  "reservation.list", "cancel.preview", "cancel.confirm",
]);

/**
 * Integration seam for the existing recipient guard. Never expose this to the
 * model as a tool. The guard calls it only after authenticating Alan's exact
 * iMessage handle, and injects the returned token into one matching tool call.
 */
export class InvocationProofIssuer {
  constructor({ credentialProvider, now = () => new Date() } = {}) {
    this.credentialProvider = credentialProvider;
    this.now = now;
  }

  async issue(evidence) {
    exactObject(evidence, [
      "guardContract", "authenticatedOwner", "principalHandle", "messageId", "messageBody", "conversationId", "runId", "channel", "action",
    ], "issuer_evidence_invalid");
    if (evidence.guardContract !== "rico-recipient-guard/v5" || evidence.authenticatedOwner !== true || evidence.channel !== "imessage") {
      throw governed("issuer_evidence_not_authorized", "Only the authenticated Rico owner route may issue an OpenTable invocation proof.");
    }
    if (!ACTIONS.has(evidence.action)) throw governed("issuer_action_invalid", "The requested OpenTable action is not issuable.");
    const principalHandle = bounded(evidence.principalHandle, 3, 256, "issuer_principal_invalid");
    const messageId = bounded(evidence.messageId, 1, 512, "issuer_message_invalid");
    const messageBody = normalizeInboundMessageBody(evidence.messageBody);
    const conversationId = bounded(evidence.conversationId, 1, 512, "issuer_conversation_invalid");
    const runId = bounded(evidence.runId, 1, 512, "issuer_run_invalid");
    const now = this.date();
    return this.credentialProvider.withSecret(async (secret) => {
      const bundle = parseCredentialBundle(secret, now);
      return signInvocationProof({
        schema: "openclaw.opentable.invocation",
        version: 1,
        audience: "openclaw-opentable-mcp",
        issuer: "rico-recipient-guard",
        guardContract: "rico-recipient-guard/v5",
        injectionMode: "before_tool_call_overwrite",
        principalDigest: sha256(principalHandle),
        principalRole: "owner",
        channel: "imessage",
        messageDigest: sha256(messageId),
        messageBodyDigest: sha256(messageBody),
        conversationDigest: sha256(conversationId),
        runDigest: sha256(runId),
        allowedActions: [evidence.action],
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 120_000).toISOString(),
        nonce: crypto.randomBytes(18).toString("base64url"),
      }, bundle.invocationHmacKey);
    });
  }

  date() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw governed("clock_invalid", "The OpenTable proof clock is invalid.");
    return date;
  }
}

function bounded(value, min, max, code) {
  if (typeof value !== "string" || value.length < min || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw governed(code, "The recipient-guard evidence is invalid.");
  return value;
}
