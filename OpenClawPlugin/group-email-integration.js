import crypto from "node:crypto";
import { messageHash, normalize } from "./policy.js";

const TOOL_NAME = "rico_group_email_execute";
export const RICO_GROUP_EMAIL_TOOL_DESCRIPTION = "Send one governed Outlook email from an authenticated approved Rico group request to explicitly mentioned approved people, or perform Rico's Janet meeting handoff.";
export const RICO_GROUP_EMAIL_TOOL_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["action", "recipients"],
  properties: {
    action: { type: "string", enum: ["email", "meeting_handoff"] },
    recipients: {
      type: "array", minItems: 1, maxItems: 20,
      items: {
        type: "object", additionalProperties: false,
        required: ["role", "profileId", "displayName", "mention"],
        properties: {
          role: { type: "string", enum: ["to", "cc"] },
          profileId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
          displayName: { type: "string", minLength: 1, maxLength: 100 },
          mention: { type: "string", minLength: 1, maxLength: 100 },
        },
      },
    },
    subject: { type: "string", minLength: 1, maxLength: 160 },
    body: { type: "string", minLength: 80, maxLength: 20_000 },
    attachments: {
      type: "array", maxItems: 5,
      items: {
        type: "object", additionalProperties: false,
        required: ["path", "mime", "byteSize", "sha256"],
        properties: {
          path: { type: "string" }, mime: { type: "string" },
          byteSize: { type: "integer", minimum: 1, maximum: 26_214_400 },
          sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        },
      },
    },
  },
});

/**
 * Ephemeral two-stage authority: before_tool_call mints a run/tool-call bound
 * grant, tool execution atomically consumes it, and the broker then consumes
 * the resulting exact principal proof. Nothing is written to disk.
 */
export function createGroupEmailExecutionRegistry({ ttlMs = 2 * 60 * 1000, now = () => Date.now() } = {}) {
  const grants = new Map();
  const proofs = new Map();
  const prune = () => {
    const cutoff = now() - ttlMs;
    for (const [key, value] of grants) if (value.createdAt < cutoff) grants.delete(key);
    for (const [key, value] of proofs) if (value.createdAt < cutoff) proofs.delete(key);
  };
  const grantKey = (runId, toolCallId) => `${runId}\u0000${toolCallId}`;

  return {
    authorize(input) {
      prune();
      const value = validateGrant(input);
      const key = grantKey(value.runId, value.toolCallId);
      if (grants.has(key)) return false;
      grants.set(key, Object.freeze({ ...value, createdAt: now() }));
      return true;
    },
    consume(runtimeContext) {
      prune();
      if (!runtimeContext || typeof runtimeContext !== "object" || Array.isArray(runtimeContext)
        || Object.keys(runtimeContext).length !== 1 || !Object.hasOwn(runtimeContext, "toolCallId")) {
        throw coded("group_email_execution_context_unproven");
      }
      const toolCallId = exactText(runtimeContext?.toolCallId);
      if (!toolCallId) throw coded("group_email_execution_context_unproven");
      const matches = [...grants.entries()].filter(([, grant]) =>
        grant.toolCallId === toolCallId);
      if (matches.length !== 1) throw coded("group_email_single_use_grant_unavailable");
      const [key, grant] = matches[0];
      grants.delete(key);
      const proofKey = principalKey(grant.origin, grant.groupTarget);
      if (proofs.has(proofKey)) throw coded("group_email_principal_proof_collision");
      proofs.set(proofKey, Object.freeze({ ...grant, createdAt: now() }));
      return Object.freeze({
        ok: true,
        source: "rico-recipient-guard/v5",
        channel: "imessage",
        conversationType: "group",
        runId: grant.runId,
        messageId: grant.origin.messageId,
        conversationId: grant.origin.conversationId,
        groupTarget: grant.groupTarget,
        groupRevision: grant.groupRevision,
        senderHandle: grant.senderHandle,
        body: grant.origin.body,
        bodyHash: grant.origin.bodyHash,
      });
    },
    verifyInboundPrincipal(request) {
      prune();
      const groupTarget = normalize(request?.expectedGroupTarget);
      const origin = {
        messageId: exactText(request?.messageId),
        conversationId: exactText(request?.conversationId),
        bodyHash: exactDigest(request?.expectedBodyHash),
      };
      if (request?.channel !== "imessage" || request?.requireGroup !== true || request?.requireAuthenticated !== true ||
          !groupTarget || !origin.messageId || !origin.conversationId || !origin.bodyHash) {
        throw coded("group_email_principal_request_invalid");
      }
      const key = principalKey(origin, groupTarget);
      const proof = proofs.get(key);
      if (!proof) throw coded("group_email_principal_proof_unavailable");
      proofs.delete(key);
      return Object.freeze({
        ok: true,
        channel: "imessage",
        direction: "inbound",
        group: true,
        messageId: proof.origin.messageId,
        conversationId: proof.origin.conversationId,
        groupTarget: proof.groupTarget,
        senderHandle: proof.senderHandle,
        participantHandles: proof.participantHandles,
        bodyHash: proof.origin.bodyHash,
        receivedAt: proof.origin.receivedAt,
        authenticationSource: "openclaw-gateway-exact-principal",
      });
    },
    forgetRun(runId) {
      prune();
      const exact = exactText(runId);
      if (!exact) return 0;
      let removed = 0;
      for (const [key, value] of grants) if (value.runId === exact) { grants.delete(key); removed += 1; }
      for (const [key, value] of proofs) if (value.runId === exact) { proofs.delete(key); removed += 1; }
      return removed;
    },
  };
}

function validateGrant(input) {
  const runId = exactText(input?.runId);
  const toolCallId = exactText(input?.toolCallId);
  const sessionKey = exactText(input?.sessionKey, 1024);
  const sessionId = exactText(input?.sessionId);
  const senderHandle = normalize(input?.senderHandle);
  const groupTarget = normalize(input?.groupTarget);
  const groupRevision = Number(input?.groupRevision);
  const origin = input?.origin;
  const participants = Array.isArray(input?.participantHandles) ? input.participantHandles.map(normalize) : [];
  if (!runId || !toolCallId || !sessionKey || !sessionId || !senderHandle || input?.senderIsOwner !== true ||
      (!sessionKey.toLowerCase().startsWith("agent:rico-shared:imessage:group:") ||
        sessionKey.toLowerCase().includes(":direct:")) ||
      !/^chat_(?:id|guid|identifier):.+$/iu.test(groupTarget) || !Number.isSafeInteger(groupRevision) || groupRevision < 1 ||
      !origin || !exactText(origin.messageId) || !exactText(origin.conversationId) || !exactText(origin.body, 4000, true) ||
      exactDigest(origin.bodyHash) !== messageHash(origin.body) || !Number.isFinite(Date.parse(origin.receivedAt)) ||
      participants.length < 1 || new Set(participants).size !== participants.length || !participants.includes(senderHandle)) {
    throw coded("group_email_grant_invalid");
  }
  return Object.freeze({ runId, toolCallId, sessionKey, sessionId, senderHandle, senderIsOwner: true, groupTarget, groupRevision,
    participantHandles: Object.freeze([...participants].sort()), origin: Object.freeze({ ...origin }) });
}

function principalKey(origin, groupTarget) {
  return crypto.createHash("sha256").update([
    exactText(origin.messageId), exactText(origin.conversationId), exactDigest(origin.bodyHash), normalize(groupTarget),
  ].join("\u0000"), "utf8").digest("hex");
}

function exactText(value, max = 512, multiline = false) {
  const text = String(value ?? "").normalize("NFC").trim();
  if (!text || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text) ||
      (!multiline && /[\r\n]/u.test(text)) || /\r/u.test(text)) return "";
  return text;
}

function exactDigest(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/u.test(text) ? text : "";
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export { TOOL_NAME as RICO_GROUP_EMAIL_TOOL_NAME };
