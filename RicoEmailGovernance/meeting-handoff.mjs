import {
  assertEmailSendProof,
  assertThreadReplyProof,
  validateAdapter,
  verifyEmailPreflight,
  verifyInboundPrincipal,
  verifyThreadReplyPreflight,
} from "./adapter-contract.mjs";
import {
  MEETING_HANDOFF_RECIPIENT,
  MEETING_HANDOFF_SUBJECT_PREFIX,
  MEETING_REQUEST_REPLY,
  OUTLOOK_BUNDLE_ID,
  OUTLOOK_CLIENT,
} from "./definition.mjs";
import {
  assertNoPrivateProvenanceDisclosure,
  isMeetingRequest,
  sha256,
  signedEmailBody,
  validateInboundReference,
  validateMeetingHandoffGrant,
  validatePersonEmailAuthorization,
} from "./policy.mjs";

const MEETING_TIMEZONE = "America/New_York";

export class MeetingHandoffEngine {
  constructor({ adapter, ledger, permissionGrant }) {
    this.adapter = validateAdapter(adapter, { meeting: true });
    if (!ledger || typeof ledger.reserve !== "function" || typeof ledger.complete !== "function") throw coded("delivery_ledger_missing");
    this.ledger = ledger;
    this.grant = validateMeetingHandoffGrant(permissionGrant);
  }

  async handle({ inbound, authorization }) {
    const profile = validatePersonEmailAuthorization(authorization);
    if (!this.grant.enabled) throw coded("meeting_handoff_disabled");
    const reference = validateInboundReference(inbound);
    if (!isMeetingRequest(reference.body)) throw coded("meeting_request_not_detected");
    const principal = await verifyInboundPrincipal({
      adapter: this.adapter,
      reference,
      expectedHandle: profile.principal.handle,
    });

    // Both delivery paths are proven before the requester is told a handoff
    // will occur. Failure here produces no text and no email.
    await verifyEmailPreflight({
      adapter: this.adapter,
      senderAccount: this.grant.senderAccount,
      recipient: MEETING_HANDOFF_RECIPIENT,
      hasAttachments: false,
    });
    await verifyThreadReplyPreflight({
      adapter: this.adapter,
      conversationId: reference.conversationId,
      recipientHandle: principal.handle,
    });

    const requestKey = meetingRequestKey({ reference, profile });
    const requesterReply = await this.replyOnce({ requestKey, reference, profile, principal });
    // The Janet email is an independent, preauthorized action. It is attempted
    // once even if the iMessage outcome is unknown, and its own claim prevents
    // duplicate delivery after a crash or replay.
    const janetEmail = await this.emailJanetOnce({ requestKey, reference, profile, principal });
    return Object.freeze({
      status: requesterReply === "confirmed" && janetEmail === "confirmed" ? "completed" : "attention",
      requestKey,
      requesterReply,
      janetEmail,
    });
  }

  async replyOnce({ requestKey, reference, profile, principal }) {
    const reserved = this.ledger.reserve({
      requestKey,
      action: "meeting-requester-reply",
      evidence: {
        principalHash: sha256(principal.handle),
        profileHash: sha256(`${profile.profileId}:${profile.revision}`),
      },
    });
    if (!reserved) return "already-claimed";
    try {
      const proof = await this.adapter.replyInThread({
        channel: "imessage",
        conversationId: reference.conversationId,
        recipientHandle: principal.handle,
        text: MEETING_REQUEST_REPLY,
        idempotencyKey: `rico-meeting-reply:${requestKey}`,
        sameThreadRequired: true,
      });
      const confirmed = assertThreadReplyProof(proof, {
        conversationId: reference.conversationId,
        recipientHandle: principal.handle,
      });
      this.ledger.complete({
        requestKey,
        action: "meeting-requester-reply",
        status: "confirmed",
        evidence: { providerMessageIdHash: sha256(confirmed.messageId) },
      });
      return "confirmed";
    } catch (error) {
      this.ledger.complete({
        requestKey,
        action: "meeting-requester-reply",
        status: "outcome-unknown",
        evidence: { errorCode: safeErrorCode(error) },
      });
      return "outcome-unknown";
    }
  }

  async emailJanetOnce({ requestKey, reference, profile, principal }) {
    const reserved = this.ledger.reserve({
      requestKey,
      action: "meeting-handoff-email",
      evidence: {
        principalHash: sha256(principal.handle),
        profileHash: sha256(`${profile.profileId}:${profile.revision}`),
        senderHash: sha256(this.grant.senderAccount),
        recipientHash: sha256(MEETING_HANDOFF_RECIPIENT),
      },
    });
    if (!reserved) return "already-claimed";
    const message = buildMeetingHandoffEmail({
      displayName: profile.displayName,
      receivedAt: principal.receivedAt,
      requestBody: reference.body,
    });
    try {
      const proof = await this.adapter.sendEmail({
        client: OUTLOOK_CLIENT,
        clientBundleId: OUTLOOK_BUNDLE_ID,
        from: this.grant.senderAccount,
        to: MEETING_HANDOFF_RECIPIENT,
        cc: [],
        bcc: [],
        subject: message.subject,
        text: message.text,
        attachments: [],
        idempotencyKey: `rico-meeting-handoff:${requestKey}`,
        requireSourceAccountProof: true,
        noSenderFallback: true,
      });
      const confirmed = assertEmailSendProof(proof, {
        senderAccount: this.grant.senderAccount,
        recipient: MEETING_HANDOFF_RECIPIENT,
      });
      this.ledger.complete({
        requestKey,
        action: "meeting-handoff-email",
        status: "confirmed",
        evidence: { providerMessageIdHash: sha256(confirmed.messageId) },
      });
      return "confirmed";
    } catch (error) {
      this.ledger.complete({
        requestKey,
        action: "meeting-handoff-email",
        status: "outcome-unknown",
        evidence: { errorCode: safeErrorCode(error) },
      });
      return "outcome-unknown";
    }
  }
}

export function buildMeetingHandoffEmail({ displayName, receivedAt, requestBody }) {
  const message = buildMeetingHandoffDraft({ displayName, receivedAt, requestBody });
  return Object.freeze({ subject: message.subject, text: signedEmailBody(message.body) });
}

export function buildMeetingHandoffDraft({ displayName, receivedAt, requestBody }) {
  const subject = `${MEETING_HANDOFF_SUBJECT_PREFIX} ${displayName}`;
  // The exact private message remains in the authenticated inbound ledger but
  // is never repeated into email. Janet needs who and when, not provenance or
  // a copy of a private conversation.
  void requestBody;
  const body = [
    "Janet —",
    "",
    `${displayName} requested that a meeting be arranged. Rico received the request on ${formatEastern(receivedAt)}.`,
    "",
    `Please reach out directly to ${displayName} to make arrangements. Rico has not created, modified, or represented that any calendar event exists.`,
  ].join("\n");
  assertNoPrivateProvenanceDisclosure(`${subject}\n${body}`);
  return Object.freeze({ subject, body });
}

export function meetingRequestKey({ reference, profile }) {
  return sha256([
    "meeting-handoff-v1",
    reference.messageId,
    reference.conversationId,
    reference.bodyHash,
    profile.profileId,
    profile.revision,
    profile.principal.handle,
  ].join("\u0000"));
}

function formatEastern(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw coded("meeting_received_at_invalid");
  return new Intl.DateTimeFormat("en-US", {
    timeZone: MEETING_TIMEZONE,
    dateStyle: "long",
    timeStyle: "long",
  }).format(date);
}

function safeErrorCode(error) {
  return String(error?.code ?? error?.name ?? "unknown").toLowerCase().replace(/[^a-z0-9_-]+/gu, "_").slice(0, 80) || "unknown";
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
