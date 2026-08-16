import crypto from "node:crypto";
import { exactObject, sha256 } from "./canonical.mjs";
import { parseCredentialBundle } from "./credentials.mjs";
import { governed } from "./errors.mjs";
import { normalizeInboundMessageBody, normalizeToolArguments, signInvocationProof } from "./invocation-proof.mjs";

export const TOOL_ACTIONS = Object.freeze({
  uber_location_search: "uber.location_search",
  uber_location_resolve: "uber.location_resolve",
  uber_products_estimate: "uber.products_estimate",
  uber_create_reviewed_challenge: "uber.create_challenge",
  uber_confirm_request: "uber.confirm_request",
  uber_current_status: "uber.current_status",
  uber_cancel_preview: "uber.cancel_preview",
  uber_cancel_confirm: "uber.cancel_confirm",
});

/** Production recipient-guard seam; never register this class as an MCP tool. */
export class InvocationProofIssuerV5 {
  constructor({ credentialProvider, now = () => new Date() } = {}) {
    if (!credentialProvider) throw governed("issuer_provider_missing", "The Uber proof issuer requires the Keychain provider.");
    this.credentialProvider = credentialProvider;
    this.now = now;
  }

  async issue(evidence) {
    const normalized = validateEvidence(evidence);
    const now = this.date();
    return this.credentialProvider.withSecret(async (secret) => {
      const bundle = parseCredentialBundle(secret, now);
      return signInvocationProof({
        schema: "openclaw.uber.invocation",
        version: 2,
        audience: "openclaw-uber-mcp",
        issuer: "rico-recipient-guard",
        guardContract: "rico-recipient-guard/v5",
        injectionMode: "before_tool_call_overwrite",
        principalDigest: sha256(normalized.principalHandle),
        principalRole: "owner",
        channel: "imessage",
        messageIdDigest: sha256(normalized.messageId),
        messageBodyDigest: sha256(normalized.messageBody),
        conversationDigest: sha256(normalized.conversationId),
        runIdDigest: sha256(normalized.runId),
        action: normalized.action,
        argsDigest: sha256(normalized.toolArguments),
        toolCallIdDigest: sha256(normalized.toolCallId),
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 90_000).toISOString(),
        nonce: crypto.randomBytes(18).toString("base64url"),
      }, bundle.invocationHmacKey);
    });
  }

  async inject(evidence) {
    const normalized = validateEvidence(evidence);
    const token = await this.issue(evidence);
    return Object.freeze({ ...normalized.toolArguments, invocation_proof: token });
  }

  date() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw governed("clock_invalid", "The Uber proof-issuer clock is invalid.");
    return date;
  }
}

export const InvocationProofIssuer = InvocationProofIssuerV5;

function validateEvidence(evidence) {
  exactObject(evidence, [
    "guardContract", "authenticatedOwner", "principalHandle", "messageId", "messageBody",
    "conversationId", "runId", "channel", "toolName", "toolArguments", "toolCallId",
  ], "issuer_evidence_invalid");
  if (evidence.guardContract !== "rico-recipient-guard/v5" || evidence.authenticatedOwner !== true || evidence.channel !== "imessage") {
    throw governed("issuer_evidence_not_authorized", "Only the authenticated owner iMessage route may issue an Uber proof.");
  }
  const action = TOOL_ACTIONS[evidence.toolName];
  if (!action) throw governed("issuer_action_invalid", "The requested Uber tool is not proof-issuable.");
  return Object.freeze({
    principalHandle: bounded(evidence.principalHandle, 3, 256, "issuer_principal_invalid"),
    messageId: bounded(evidence.messageId, 1, 512, "issuer_message_invalid"),
    messageBody: normalizeInboundMessageBody(evidence.messageBody),
    conversationId: bounded(evidence.conversationId, 1, 512, "issuer_conversation_invalid"),
    runId: bounded(evidence.runId, 1, 512, "issuer_run_invalid"),
    toolCallId: bounded(evidence.toolCallId, 1, 512, "issuer_tool_call_invalid"),
    toolArguments: Object.freeze(normalizeToolArguments(evidence.toolArguments)),
    action,
  });
}

function bounded(value, min, max, code) {
  if (typeof value !== "string" || value.length < min || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw governed(code, "The recipient-guard evidence is invalid.");
  }
  return value;
}
