import {
  normalizeEmail,
  normalizeIMessageHandle,
  RicoEmailPolicyError,
} from "./policy.mjs";
import { OUTLOOK_BUNDLE_ID, OUTLOOK_CLIENT } from "./definition.mjs";

const AUTHENTICATION_SOURCE = "openclaw-gateway-exact-principal";

export function validateAdapter(adapter, { meeting = false } = {}) {
  if (!adapter || typeof adapter !== "object" || Array.isArray(adapter)) throw coded("outlook_adapter_missing");
  const methods = meeting
    ? ["verifyInboundPrincipal", "preflightEmailSend", "preflightThreadReply", "sendEmail", "replyInThread"]
    : ["verifyInboundPrincipal", "preflightEmailSend", "sendEmail"];
  for (const method of methods) if (typeof adapter[method] !== "function") throw coded(`outlook_adapter_${method}_missing`);
  return adapter;
}

export async function verifyInboundPrincipal({ adapter, reference, expectedHandle }) {
  const proof = await adapter.verifyInboundPrincipal({
    channel: "imessage",
    messageId: reference.messageId,
    conversationId: reference.conversationId,
    expectedBodyHash: reference.bodyHash,
    requireDirect: true,
    requireAuthenticated: true,
  });
  exactKeys(proof, [
    "ok",
    "channel",
    "direction",
    "direct",
    "messageId",
    "conversationId",
    "senderHandle",
    "bodyHash",
    "receivedAt",
    "authenticationSource",
  ], "inbound principal proof");
  if (proof.ok !== true
    || proof.channel !== "imessage"
    || proof.direction !== "inbound"
    || proof.direct !== true
    || proof.authenticationSource !== AUTHENTICATION_SOURCE) throw coded("inbound_principal_unproven");
  if (String(proof.messageId ?? "").trim() !== reference.messageId) throw coded("inbound_message_id_mismatch");
  if (String(proof.conversationId ?? "").trim() !== reference.conversationId) throw coded("inbound_conversation_id_mismatch");
  if (String(proof.bodyHash ?? "").trim().toLowerCase() !== reference.bodyHash) throw coded("inbound_body_mismatch");
  const handle = normalizeIMessageHandle(proof.senderHandle);
  if (!handle || handle !== expectedHandle) throw coded("inbound_principal_mismatch");
  const receivedAt = new Date(String(proof.receivedAt ?? ""));
  if (!Number.isFinite(receivedAt.getTime())) throw coded("inbound_received_at_invalid");
  return Object.freeze({ handle, receivedAt: receivedAt.toISOString() });
}

export async function verifyEmailPreflight({ adapter, senderAccount, recipient, hasAttachments }) {
  const proof = await adapter.preflightEmailSend({
    client: OUTLOOK_CLIENT,
    clientBundleId: OUTLOOK_BUNDLE_ID,
    senderAccount,
    recipient,
    hasAttachments,
    requiredCapabilities: [
      "outlook.desktop-client-proof",
      "outlook.exact-source-account-proof",
      "outlook.exact-recipient-proof",
      "outlook.no-sender-fallback",
      "outlook.idempotent-send",
    ],
  });
  exactKeys(proof, [
    "ok",
    "client",
    "clientBundleId",
    "senderAccount",
    "recipient",
    "outlookClientProven",
    "sourceAccountProven",
    "recipientProven",
    "noSenderFallback",
    "idempotentSends",
    "attachmentsSupported",
  ], "email preflight proof");
  if (proof.ok !== true
    || proof.client !== OUTLOOK_CLIENT
    || proof.clientBundleId !== OUTLOOK_BUNDLE_ID
    || proof.outlookClientProven !== true
    || proof.sourceAccountProven !== true
    || proof.recipientProven !== true
    || proof.noSenderFallback !== true
    || proof.idempotentSends !== true
    || (hasAttachments && proof.attachmentsSupported !== true)) throw coded("outlook_send_capability_unproven");
  if (normalizeEmail(proof.senderAccount) !== senderAccount) throw coded("outlook_source_account_mismatch");
  if (normalizeEmail(proof.recipient) !== recipient) throw coded("outlook_recipient_mismatch");
  return Object.freeze({ ok: true });
}

export async function verifyThreadReplyPreflight({ adapter, conversationId, recipientHandle }) {
  const proof = await adapter.preflightThreadReply({
    channel: "imessage",
    conversationId,
    recipientHandle,
    sameThreadRequired: true,
    idempotentRequired: true,
  });
  exactKeys(proof, ["ok", "channel", "conversationId", "recipientHandle", "sameThread", "idempotentReplies"], "thread reply preflight proof");
  if (proof.ok !== true || proof.channel !== "imessage" || proof.sameThread !== true || proof.idempotentReplies !== true) {
    throw coded("thread_reply_capability_unproven");
  }
  if (String(proof.conversationId ?? "").trim() !== conversationId) throw coded("thread_reply_conversation_mismatch");
  if (normalizeIMessageHandle(proof.recipientHandle) !== recipientHandle) throw coded("thread_reply_recipient_mismatch");
  return Object.freeze({ ok: true });
}

export function assertEmailSendProof(proof, { senderAccount, recipient }) {
  exactKeys(proof, [
    "ok",
    "client",
    "clientBundleId",
    "from",
    "to",
    "messageId",
    "sourceAccountProven",
    "noSenderFallback",
  ], "email send proof");
  if (proof.ok !== true
    || proof.client !== OUTLOOK_CLIENT
    || proof.clientBundleId !== OUTLOOK_BUNDLE_ID
    || proof.sourceAccountProven !== true
    || proof.noSenderFallback !== true) throw coded("email_send_unconfirmed");
  if (normalizeEmail(proof.from) !== senderAccount) throw coded("email_send_source_mismatch");
  if (normalizeEmail(proof.to) !== recipient) throw coded("email_send_recipient_mismatch");
  if (!String(proof.messageId ?? "").trim()) throw coded("email_send_message_id_missing");
  return Object.freeze({ messageId: String(proof.messageId).trim() });
}

export function assertThreadReplyProof(proof, { conversationId, recipientHandle }) {
  exactKeys(proof, ["ok", "channel", "conversationId", "recipientHandle", "messageId", "sameThread"], "thread reply proof");
  if (proof.ok !== true || proof.channel !== "imessage" || proof.sameThread !== true) throw coded("thread_reply_unconfirmed");
  if (String(proof.conversationId ?? "").trim() !== conversationId) throw coded("thread_reply_conversation_mismatch");
  if (normalizeIMessageHandle(proof.recipientHandle) !== recipientHandle) throw coded("thread_reply_recipient_mismatch");
  if (!String(proof.messageId ?? "").trim()) throw coded("thread_reply_message_id_missing");
  return Object.freeze({ messageId: String(proof.messageId).trim() });
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw coded(`${label.replaceAll(" ", "_")}_invalid`);
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) throw coded(`${label.replaceAll(" ", "_")}_fields_invalid`);
}

function coded(code) {
  return new RicoEmailPolicyError(code);
}
