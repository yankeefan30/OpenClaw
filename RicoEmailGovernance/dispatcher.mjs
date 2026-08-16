import {
  assertEmailSendProof,
  validateAdapter,
  verifyEmailPreflight,
  verifyInboundPrincipal,
} from "./adapter-contract.mjs";
import { verifyLocalAttachments } from "./attachments.mjs";
import { OUTLOOK_BUNDLE_ID, OUTLOOK_CLIENT } from "./definition.mjs";
import {
  sha256,
  signedEmailBody,
  validateDetailedDraft,
  validateInboundReference,
  validatePersonEmailAuthorization,
} from "./policy.mjs";

export class AuthorizedPersonEmailDispatcher {
  constructor({ adapter, ledger, allowedAttachmentRoots = [] }) {
    this.adapter = validateAdapter(adapter);
    if (!ledger || typeof ledger.reserve !== "function" || typeof ledger.complete !== "function") throw coded("delivery_ledger_missing");
    this.ledger = ledger;
    this.allowedAttachmentRoots = [...allowedAttachmentRoots];
  }

  async send({ inbound, authorization, draft }) {
    const profile = validatePersonEmailAuthorization(authorization);
    if (!profile.email.enabled) throw coded("profile_email_disabled");
    const reference = validateInboundReference(inbound);
    const emailDraft = validateDetailedDraft(draft);
    if (emailDraft.attachments.length > 0 && !profile.email.attachmentsAllowed) throw coded("profile_attachments_disabled");

    const principal = await verifyInboundPrincipal({
      adapter: this.adapter,
      reference,
      expectedHandle: profile.principal.handle,
    });
    await verifyEmailPreflight({
      adapter: this.adapter,
      senderAccount: profile.email.senderAccount,
      recipient: profile.email.recipientEmail,
      hasAttachments: emailDraft.attachments.length > 0,
    });
    const attachments = emailDraft.attachments.length === 0
      ? []
      : verifyLocalAttachments(emailDraft.attachments, this.allowedAttachmentRoots);
    const requestKey = personEmailRequestKey({ reference, profile });
    const reserved = this.ledger.reserve({
      requestKey,
      action: "person-email",
      evidence: {
        principalHash: sha256(principal.handle),
        profileHash: sha256(`${profile.profileId}:${profile.revision}`),
        senderHash: sha256(profile.email.senderAccount),
        recipientHash: sha256(profile.email.recipientEmail),
        attachmentCount: attachments.length,
      },
    });
    if (!reserved) return Object.freeze({ status: "already-claimed", requestKey });

    try {
      const proof = await this.adapter.sendEmail({
        client: OUTLOOK_CLIENT,
        clientBundleId: OUTLOOK_BUNDLE_ID,
        from: profile.email.senderAccount,
        to: profile.email.recipientEmail,
        cc: [],
        bcc: [],
        subject: emailDraft.subject,
        text: signedEmailBody(emailDraft.body),
        attachments,
        idempotencyKey: `rico-person-email:${requestKey}`,
        requireSourceAccountProof: true,
        noSenderFallback: true,
      });
      const confirmed = assertEmailSendProof(proof, {
        senderAccount: profile.email.senderAccount,
        recipient: profile.email.recipientEmail,
      });
      this.ledger.complete({
        requestKey,
        action: "person-email",
        status: "confirmed",
        evidence: { providerMessageIdHash: sha256(confirmed.messageId) },
      });
      return Object.freeze({ status: "sent", requestKey });
    } catch (error) {
      this.ledger.complete({
        requestKey,
        action: "person-email",
        status: "outcome-unknown",
        evidence: { errorCode: safeErrorCode(error) },
      });
      return Object.freeze({ status: "outcome-unknown", requestKey, errorCode: safeErrorCode(error) });
    }
  }
}

export function personEmailRequestKey({ reference, profile }) {
  return sha256([
    "person-email-v1",
    reference.messageId,
    reference.conversationId,
    reference.bodyHash,
    profile.profileId,
    profile.revision,
    profile.principal.handle,
  ].join("\u0000"));
}

function safeErrorCode(error) {
  return String(error?.code ?? error?.name ?? "unknown").toLowerCase().replace(/[^a-z0-9_-]+/gu, "_").slice(0, 80) || "unknown";
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
