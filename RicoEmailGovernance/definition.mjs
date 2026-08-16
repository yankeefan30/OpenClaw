export const OUTLOOK_CLIENT = "outlook";
export const OUTLOOK_BUNDLE_ID = "com.microsoft.Outlook";

export const ALLOWED_SENDER_ACCOUNTS = Object.freeze([
  "alan.a.rosa@gmail.com",
  "alan.rosa@cvshealth.com",
]);

// The spelling is intentionally preserved from Alan's reviewed instruction.
// It is appended by the enforcement layer and is never accepted from a model.
export const EMAIL_SIGNATURE = "Rico an Autonmous Agent on behalf of Alan Rosa";

export const EMAIL_COMPOSITION_POLICY = deepFreeze({
  schema: "rico.email-composition-policy",
  schemaVersion: 1,
  voice: [
    "detail-oriented",
    "lawyer-like",
    "well-polished",
    "complete",
    "highly-technical",
    "fact-based",
  ],
  requirements: [
    "Separate known facts from assumptions.",
    "Do not invent facts, citations, attachments, commitments, or authority.",
    "Use precise dates, names, and technical terms when the evidence supports them.",
    "Do not add a signature; the enforcement layer appends the exact approved signature.",
  ],
});

export const MEETING_REQUEST_REPLY = "I can't set up meetings directly only Janet Cummings can do that but what I can do is send Janet an text message now that you have asked me to set up a meeting and that she should connect with you to make arrangements";
export const MEETING_HANDOFF_RECIPIENT = "janet.cummings@cvshealth.com";
export const MEETING_HANDOFF_SUBJECT_PREFIX = "Meeting has been requested by";

export const RICO_EMAIL_GOVERNANCE = deepFreeze({
  schema: "rico.email-governance",
  schemaVersion: 1,
  enabledByDefault: false,
  authentication: {
    displayNamesAreAuthentication: false,
    required: "exact authenticated inbound iMessage principal proof",
  },
  personEmail: {
    recipientScope: "the authenticated person's exact profile email only",
    senderAccounts: [...ALLOWED_SENDER_ACCOUNTS],
    client: OUTLOOK_CLIENT,
    attachmentPermissionSeparate: true,
    senderFallback: false,
  },
  meetingRequests: {
    calendarMutationAllowed: false,
    requesterReply: MEETING_REQUEST_REPLY,
    handoffRecipient: MEETING_HANDOFF_RECIPIENT,
    emailAttemptsPerRequest: 1,
    replyAttemptsPerRequest: 1,
  },
  failClosed: [
    "profile-email-disabled",
    "principal-unproven-or-mismatched",
    "recipient-unapproved",
    "sender-account-unselected-or-mismatched",
    "outlook-client-unproven",
    "attachment-permission-missing",
    "adapter-unavailable",
    "delivery-outcome-unknown",
  ],
});

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
