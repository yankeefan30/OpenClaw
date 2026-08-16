import { sha256 } from "../canonical.mjs";
import { signInvocationProof } from "../invocation-proof.mjs";

export const KEY = Buffer.alloc(32, 7).toString("base64");
export const LOCATION_KEY = Buffer.alloc(32, 8).toString("base64");
export const NOW = new Date();

export function validBundle() {
  return {
    schema: "openclaw.uber.oauth-bundle",
    version: 1,
    enabled: true,
    environment: "sandbox",
    apiBaseUrl: "https://sandbox-api.uber.com",
    oauthBaseUrl: "https://auth.uber.com",
    clientId: "client-identifier",
    clientSecret: "client-secret-value",
    accessToken: "access-token-value",
    refreshToken: "refresh-token-value",
    tokenType: "Bearer",
    expiresAt: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
    scopes: ["request", "offline_access"],
    invocationHmacKey: KEY,
    locationHmacKey: LOCATION_KEY,
    paymentAliases: { personal: "payment-personal-opaque", business: "payment-business-opaque" },
    approval: {
      privilegedRequestApproved: true,
      ownerAuthorized: true,
      approvedAt: new Date(NOW.getTime() - 60_000).toISOString(),
      expiresAt: new Date(NOW.getTime() + 365 * 24 * 60 * 60_000).toISOString(),
      reference: "reviewed-development-account",
    },
  };
}

export function proofFor(action, args, {
  clock = NOW,
  messageBody = "@rico uber request",
  messageId = "message-default",
  runId = "run-default",
  conversationId = "owner-conversation",
  toolCallId = "tool-call-default",
  principalDigest = "a".repeat(64),
} = {}) {
  return signInvocationProof({
    schema: "openclaw.uber.invocation",
    version: 2,
    audience: "openclaw-uber-mcp",
    issuer: "rico-recipient-guard",
    guardContract: "rico-recipient-guard/v5",
    injectionMode: "before_tool_call_overwrite",
    principalDigest,
    principalRole: "owner",
    channel: "imessage",
    messageIdDigest: sha256(messageId),
    messageBodyDigest: sha256(messageBody.normalize("NFKC").trim()),
    conversationDigest: sha256(conversationId),
    runIdDigest: sha256(runId),
    action,
    argsDigest: sha256(args),
    toolCallIdDigest: sha256(toolCallId),
    issuedAt: new Date(clock.getTime() - 1_000).toISOString(),
    expiresAt: new Date(clock.getTime() + 90_000).toISOString(),
    nonce: "abcdefghijklmnop1234",
  }, KEY);
}

export function withProof(action, args, options) {
  return { ...args, invocation_proof: proofFor(action, args, options) };
}
