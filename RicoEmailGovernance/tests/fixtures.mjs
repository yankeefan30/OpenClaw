import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeliveryLedger } from "../ledger.mjs";
import { OUTLOOK_BUNDLE_ID } from "../definition.mjs";
import { sha256 } from "../policy.mjs";

export function personAuthorization(overrides = {}) {
  const base = {
    schema: "rico.person-email-authorization",
    schemaVersion: 1,
    profileId: "person-janet-cummings",
    contactIdentifierHash: "c".repeat(64),
    displayName: "Janet Cummings",
    // Matches Studio's canonical RicoPersonPrincipal Codable shape.
    principal: { kind: "phone", handle: "+12145550123" },
    email: {
      enabled: true,
      attachmentsAllowed: false,
      recipientEmail: "janet@example.com",
      recipientSource: {
        kind: "macos-contacts-reviewed-email",
        contactIdentifierHash: "c".repeat(64),
        emailValueHash: sha256("janet@example.com"),
        reviewedAt: "2026-08-15T12:00:00.000Z",
      },
      senderAccount: "alan.a.rosa@gmail.com",
      client: "outlook",
    },
    revision: 1,
    authorizedAt: "2026-08-15T12:00:00.000Z",
  };
  const contactIdentifierHash = overrides.contactIdentifierHash ?? base.contactIdentifierHash;
  const email = { ...base.email, ...(overrides.email ?? {}) };
  if (!Object.prototype.hasOwnProperty.call(overrides.email ?? {}, "recipientSource")
      && (Object.prototype.hasOwnProperty.call(overrides.email ?? {}, "recipientEmail")
        || Object.prototype.hasOwnProperty.call(overrides, "contactIdentifierHash"))) {
    email.recipientSource = email.recipientEmail === null ? null : {
      kind: "macos-contacts-reviewed-email",
      contactIdentifierHash,
      emailValueHash: sha256(String(email.recipientEmail).trim().toLowerCase()),
      reviewedAt: "2026-08-15T12:00:00.000Z",
    };
  }
  return {
    ...base,
    ...overrides,
    contactIdentifierHash,
    principal: { ...base.principal, ...(overrides.principal ?? {}) },
    email,
  };
}

export function meetingGrant(overrides = {}) {
  return {
    schema: "rico.meeting-handoff-grant",
    schemaVersion: 1,
    enabled: true,
    janetEmail: "janet.cummings@cvshealth.com",
    senderAccount: "alan.rosa@cvshealth.com",
    client: "outlook",
    issuedAt: "2026-08-15T12:00:00.000Z",
    ...overrides,
  };
}

export function inbound(overrides = {}) {
  return {
    messageId: "imsg-message-123",
    conversationId: "chat-guid-456",
    body: "Rico, please schedule a meeting with Alan next Tuesday afternoon.",
    ...overrides,
  };
}

export function detailedDraft(overrides = {}) {
  return {
    subject: "Technical follow-up and supporting detail",
    body: "Thank you for your request. Based on the reviewed record, the relevant technical facts and limitations are set out below so that the conclusion and next steps are clear.",
    attachments: [],
    ...overrides,
  };
}

export function harness({
  profile = personAuthorization(),
  grant = meetingGrant(),
  verifyInboundPrincipal,
  preflightEmailSend,
  preflightThreadReply,
  sendEmail,
  replyInThread,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rico-email-governance-"));
  fs.chmodSync(root, 0o700);
  const calls = { verify: [], emailPreflight: [], replyPreflight: [], sendEmail: [], reply: [] };
  const adapter = {
    verifyInboundPrincipal: async (request) => {
      calls.verify.push(request);
      if (verifyInboundPrincipal) return verifyInboundPrincipal(request, calls.verify.length);
      return {
        ok: true,
        channel: "imessage",
        direction: "inbound",
        direct: true,
        messageId: request.messageId,
        conversationId: request.conversationId,
        senderHandle: profile.principal.handle,
        bodyHash: request.expectedBodyHash,
        receivedAt: "2026-08-15T16:30:00.000Z",
        authenticationSource: "openclaw-gateway-exact-principal",
      };
    },
    preflightEmailSend: async (request) => {
      calls.emailPreflight.push(request);
      if (preflightEmailSend) return preflightEmailSend(request, calls.emailPreflight.length);
      return {
        ok: true,
        client: "outlook",
        clientBundleId: OUTLOOK_BUNDLE_ID,
        senderAccount: request.senderAccount,
        recipient: request.recipient,
        outlookClientProven: true,
        sourceAccountProven: true,
        recipientProven: true,
        noSenderFallback: true,
        idempotentSends: true,
        attachmentsSupported: true,
      };
    },
    preflightThreadReply: async (request) => {
      calls.replyPreflight.push(request);
      if (preflightThreadReply) return preflightThreadReply(request, calls.replyPreflight.length);
      return {
        ok: true,
        channel: "imessage",
        conversationId: request.conversationId,
        recipientHandle: request.recipientHandle,
        sameThread: true,
        idempotentReplies: true,
      };
    },
    sendEmail: async (request) => {
      calls.sendEmail.push(request);
      if (sendEmail) return sendEmail(request, calls.sendEmail.length);
      return {
        ok: true,
        client: "outlook",
        clientBundleId: OUTLOOK_BUNDLE_ID,
        from: request.from,
        to: request.to,
        messageId: `outlook-${calls.sendEmail.length}`,
        sourceAccountProven: true,
        noSenderFallback: true,
      };
    },
    replyInThread: async (request) => {
      calls.reply.push(request);
      if (replyInThread) return replyInThread(request, calls.reply.length);
      return {
        ok: true,
        channel: "imessage",
        conversationId: request.conversationId,
        recipientHandle: request.recipientHandle,
        messageId: `imsg-${calls.reply.length}`,
        sameThread: true,
      };
    },
  };
  const ledger = new DeliveryLedger(path.join(root, "claims"), () => new Date("2026-08-15T16:31:00.000Z"));
  return { root, profile, grant, adapter, ledger, calls };
}
