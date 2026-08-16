import {
  OUTLOOK_BUNDLE_ID,
  OUTLOOK_CLIENT,
  MEETING_HANDOFF_RECIPIENT,
} from "./definition.mjs";
import { verifyLocalAttachments } from "./attachments.mjs";
import { buildMeetingHandoffDraft } from "./meeting-handoff.mjs";
import {
  normalizeEmail,
  normalizeIMessageHandle,
  RicoEmailPolicyError,
  safeDisplayName,
  sha256,
  signedEmailBody,
  validateDetailedDraft,
  validateInboundReference,
  validatePersonEmailAuthorization,
  isMeetingRequest,
} from "./policy.mjs";

const AUTHENTICATION_SOURCE = "openclaw-gateway-exact-principal";
const GROUP_SCHEMA = "rico.group-email-authorization";
const GROUP_TARGET = /^chat_(?:id|guid|identifier):[^\u0000-\u001f\u007f-\u009f\s]{1,512}$/iu;

/**
 * A narrow bridge for an authenticated, approved group iMessage to one
 * Outlook email. Group membership is admission evidence only. It is never a
 * recipient list. Every To/Cc recipient must be an explicit literal mention
 * that resolves uniquely to a separate reviewed person-email authorization.
 */
export class GroupEmailBroker {
  constructor({ principalAdapter, outlookAdapter, ledger, allowedAttachmentRoots = [] }) {
    this.principalAdapter = validatePrincipalAdapter(principalAdapter);
    this.outlookAdapter = validateOutlookAdapter(outlookAdapter);
    if (!ledger || typeof ledger.reserve !== "function" || typeof ledger.complete !== "function") {
      throw coded("delivery_ledger_missing");
    }
    this.ledger = ledger;
    this.allowedAttachmentRoots = [...allowedAttachmentRoots];
  }

  async send({ inbound, groupAuthorization, authorizations, recipientDirectives, draft }) {
    return this.#send({
      action: "group-email",
      inbound,
      groupAuthorization,
      authorizations,
      recipientDirectives,
      draft,
    });
  }

  async sendMeetingHandoff({ inbound, groupAuthorization, authorizations, recipientDirectives }) {
    const reference = validateInboundReference(inbound);
    if (!isMeetingRequest(reference.body)) throw coded("meeting_request_not_detected");
    const group = validateGroupEmailAuthorization(groupAuthorization);
    const profiles = validateProfileSet(authorizations);
    const principal = await verifyGroupPrincipal({
      adapter: this.principalAdapter,
      reference,
      group,
    });
    const actor = uniqueProfileForHandle(profiles, principal.handle);
    const plan = resolveMentionedRecipients({
      body: reference.body,
      actorHandle: principal.handle,
      authorizations: profiles,
      directives: recipientDirectives,
    });
    if (plan.to.length !== 1 || plan.to[0].email !== MEETING_HANDOFF_RECIPIENT) {
      throw coded("meeting_handoff_requires_janet_as_sole_to_recipient");
    }
    const message = buildMeetingHandoffDraft({
      displayName: actor.displayName,
      receivedAt: principal.receivedAt,
      requestBody: reference.body,
    });
    return this.#sendResolved({
      action: "group-meeting-handoff-email",
      reference,
      group,
      profiles,
      principal,
      plan,
      draft: validateDetailedDraft({
        subject: message.subject,
        body: message.body,
        attachments: [],
      }),
    });
  }

  async #send({ action, inbound, groupAuthorization, authorizations, recipientDirectives, draft }) {
    const reference = validateInboundReference(inbound);
    const group = validateGroupEmailAuthorization(groupAuthorization);
    const profiles = validateProfileSet(authorizations);
    const emailDraft = validateDetailedDraft(draft);
    const principal = await verifyGroupPrincipal({
      adapter: this.principalAdapter,
      reference,
      group,
    });
    const plan = resolveMentionedRecipients({
      body: reference.body,
      actorHandle: principal.handle,
      authorizations: profiles,
      directives: recipientDirectives,
    });
    return this.#sendResolved({ action, reference, group, profiles, principal, plan, draft: emailDraft });
  }

  async #sendResolved({ action, reference, group, profiles, principal, plan, draft }) {
    const selected = [...plan.to, ...plan.cc];
    if (draft.attachments.length > 0 && selected.some((item) => item.profile.email.attachmentsAllowed !== true)) {
      throw coded("group_recipient_attachments_disabled");
    }
    // The reviewed sender account belongs to the primary To relationship.
    // A copied person authorizes Rico to deliver a copy to their exact email;
    // their own preferred From account must not silently override the sender
    // selected for the primary recipient. Multiple To recipients must still
    // agree on one exact source account or the whole request fails closed.
    const senderAccounts = [...new Set(plan.to.map((item) => item.profile.email.senderAccount))];
    if (senderAccounts.length !== 1) throw coded("group_to_sender_account_mismatch");
    const senderAccount = senderAccounts[0];
    const to = plan.to.map((item) => item.email);
    const cc = plan.cc.map((item) => item.email);
    await verifyGroupEmailPreflight({
      adapter: this.outlookAdapter,
      senderAccount,
      to,
      cc,
      hasAttachments: draft.attachments.length > 0,
    });
    const attachments = draft.attachments.length === 0
      ? []
      : verifyLocalAttachments(draft.attachments, this.allowedAttachmentRoots);
    const requestKey = groupEmailRequestKey({ reference, group, action, senderAccount, plan, profiles });
    const reserved = this.ledger.reserve({
      requestKey,
      action,
      evidence: {
        actorHash: sha256(principal.handle),
        groupHash: sha256(`${group.target}:${group.revision}`),
        senderHash: sha256(senderAccount),
        toSetHash: sha256([...to].sort().join("\u0000")),
        ccSetHash: sha256([...cc].sort().join("\u0000")),
        attachmentCount: attachments.length,
      },
    });
    if (!reserved) return Object.freeze({ status: "already-claimed", requestKey });

    try {
      const proof = await this.outlookAdapter.sendEmail({
        client: OUTLOOK_CLIENT,
        clientBundleId: OUTLOOK_BUNDLE_ID,
        from: senderAccount,
        to,
        cc,
        bcc: [],
        subject: draft.subject,
        text: signedEmailBody(draft.body),
        attachments,
        idempotencyKey: `rico-${action}:${requestKey}`,
        requireSourceAccountProof: true,
        noSenderFallback: true,
      });
      const confirmed = assertGroupEmailSendProof(proof, { senderAccount, to, cc });
      this.ledger.complete({
        requestKey,
        action,
        status: "confirmed",
        evidence: { providerMessageIdHash: sha256(confirmed.messageId) },
      });
      return Object.freeze({ status: "sent", requestKey });
    } catch (error) {
      this.ledger.complete({
        requestKey,
        action,
        status: "outcome-unknown",
        evidence: { errorCode: safeErrorCode(error) },
      });
      return Object.freeze({ status: "outcome-unknown", requestKey, errorCode: safeErrorCode(error) });
    }
  }
}

export function validateGroupEmailAuthorization(input) {
  const value = requireObject(input, "group email authorization");
  exactKeys(value, ["schema", "schemaVersion", "target", "participants", "revision", "authorizedAt"], "group email authorization");
  if (value.schema !== GROUP_SCHEMA || value.schemaVersion !== 1) throw coded("group_email_authorization_schema_invalid");
  const target = normalizeGroupTarget(value.target);
  if (!target) throw coded("group_email_target_invalid");
  if (!Array.isArray(value.participants) || value.participants.length < 1 || value.participants.length > 100) {
    throw coded("group_email_participants_invalid");
  }
  const participants = value.participants.map(normalizeIMessageHandle);
  if (participants.some((item) => !item) || new Set(participants).size !== participants.length) {
    throw coded("group_email_participants_invalid");
  }
  const revision = Number(value.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) throw coded("group_email_revision_invalid");
  const authorizedAt = new Date(String(value.authorizedAt ?? ""));
  if (!Number.isFinite(authorizedAt.getTime())) throw coded("group_email_authorized_at_invalid");
  return deepFreeze({
    schema: GROUP_SCHEMA,
    schemaVersion: 1,
    target,
    participants: [...participants].sort(),
    revision,
    authorizedAt: authorizedAt.toISOString(),
  });
}

export function resolveMentionedRecipients({ body, actorHandle, authorizations, directives }) {
  const referenceBody = String(body ?? "").normalize("NFC");
  if (!referenceBody || [...referenceBody].length > 4_000) throw coded("group_message_body_invalid");
  const actor = normalizeIMessageHandle(actorHandle);
  if (!actor) throw coded("group_actor_invalid");
  const profiles = validateProfileSet(authorizations);
  if (!Array.isArray(directives) || directives.length < 1 || directives.length > 20) {
    throw coded("group_recipient_directives_invalid");
  }
  const resolved = directives.map((input) => {
    const directive = validateDirective(input);
    if (!literalMentionPresent(referenceBody, directive.mention)) throw coded("group_recipient_not_literally_mentioned");
    const selfMention = /^(?:i|me|myself)$/iu.test(directive.mention);
    const candidates = selfMention
      ? profiles.filter((profile) => profile.principal.handle === actor)
      : profiles.filter((profile) => mentionMatchesProfile(directive.mention, profile));
    if (candidates.length !== 1) throw coded(candidates.length === 0
      ? "group_recipient_unresolved"
      : "group_recipient_ambiguous");
    const profile = candidates[0];
    if (!profile.email.enabled || !profile.email.recipientEmail) throw coded("group_recipient_email_disabled");
    return Object.freeze({
      role: directive.role,
      mention: directive.mention,
      email: profile.email.recipientEmail,
      profile,
    });
  });
  const emails = resolved.map((item) => item.email);
  if (new Set(emails).size !== emails.length) throw coded("group_recipient_duplicate");
  const to = resolved.filter((item) => item.role === "to");
  const cc = resolved.filter((item) => item.role === "cc");
  if (to.length < 1 || to.length > 10 || cc.length > 10) throw coded("group_recipient_roles_invalid");
  return deepFreeze({ to, cc });
}

export function groupEmailRequestKey({ reference, group, action, senderAccount, plan, profiles }) {
  const profileRevisions = new Map(profiles.map((profile) => [profile.profileId, profile.revision]));
  const recipients = [...plan.to, ...plan.cc]
    .map((item) => `${item.role}:${item.profile.profileId}:${profileRevisions.get(item.profile.profileId)}:${item.email}`)
    .sort();
  return sha256([
    "group-email-v1",
    action,
    reference.messageId,
    reference.conversationId,
    reference.bodyHash,
    group.target,
    group.revision,
    senderAccount,
    ...recipients,
  ].join("\u0000"));
}

async function verifyGroupPrincipal({ adapter, reference, group }) {
  const proof = await adapter.verifyInboundPrincipal({
    channel: "imessage",
    messageId: reference.messageId,
    conversationId: reference.conversationId,
    expectedBodyHash: reference.bodyHash,
    expectedGroupTarget: group.target,
    requireGroup: true,
    requireAuthenticated: true,
  });
  exactKeys(proof, [
    "ok", "channel", "direction", "group", "messageId", "conversationId",
    "groupTarget", "senderHandle", "participantHandles", "bodyHash", "receivedAt",
    "authenticationSource",
  ], "group inbound principal proof");
  if (proof.ok !== true || proof.channel !== "imessage" || proof.direction !== "inbound"
      || proof.group !== true || proof.authenticationSource !== AUTHENTICATION_SOURCE) {
    throw coded("group_inbound_principal_unproven");
  }
  if (String(proof.messageId ?? "").trim() !== reference.messageId) throw coded("group_inbound_message_id_mismatch");
  if (String(proof.conversationId ?? "").trim() !== reference.conversationId) throw coded("group_inbound_conversation_id_mismatch");
  if (String(proof.bodyHash ?? "").trim().toLowerCase() !== reference.bodyHash) throw coded("group_inbound_body_mismatch");
  if (normalizeGroupTarget(proof.groupTarget) !== group.target) throw coded("group_inbound_target_mismatch");
  const handle = normalizeIMessageHandle(proof.senderHandle);
  if (!handle || !group.participants.includes(handle)) throw coded("group_inbound_sender_not_approved");
  if (!Array.isArray(proof.participantHandles)) throw coded("group_inbound_membership_unproven");
  const live = proof.participantHandles.map(normalizeIMessageHandle);
  if (live.some((item) => !item) || new Set(live).size !== live.length
      || !sameSet(live, group.participants)) throw coded("group_inbound_membership_mismatch");
  const receivedAt = new Date(String(proof.receivedAt ?? ""));
  if (!Number.isFinite(receivedAt.getTime())) throw coded("group_inbound_received_at_invalid");
  return Object.freeze({ handle, receivedAt: receivedAt.toISOString() });
}

async function verifyGroupEmailPreflight({ adapter, senderAccount, to, cc, hasAttachments }) {
  const proof = await adapter.preflightEmailSend({
    client: OUTLOOK_CLIENT,
    clientBundleId: OUTLOOK_BUNDLE_ID,
    senderAccount,
    to,
    cc,
    bcc: [],
    hasAttachments,
    requiredCapabilities: [
      "outlook.desktop-client-proof",
      "outlook.exact-source-account-proof",
      "outlook.exact-recipient-proof",
      "outlook.no-sender-fallback",
      "outlook.idempotent-send",
      "outlook.explicit-to-cc-only",
    ],
  });
  exactKeys(proof, [
    "ok", "client", "clientBundleId", "senderAccount", "to", "cc", "bcc",
    "outlookClientProven", "sourceAccountProven", "recipientProven",
    "noSenderFallback", "idempotentSends", "explicitRecipientsOnly", "attachmentsSupported",
  ], "group email preflight proof");
  if (proof.ok !== true || proof.client !== OUTLOOK_CLIENT || proof.clientBundleId !== OUTLOOK_BUNDLE_ID
      || proof.outlookClientProven !== true || proof.sourceAccountProven !== true
      || proof.recipientProven !== true || proof.noSenderFallback !== true
      || proof.idempotentSends !== true || proof.explicitRecipientsOnly !== true
      || (hasAttachments && proof.attachmentsSupported !== true)) {
    throw coded("group_outlook_send_capability_unproven");
  }
  if (normalizeEmail(proof.senderAccount) !== senderAccount) throw coded("group_outlook_source_account_mismatch");
  assertRecipientSets(proof.to, to, "group_outlook_to_mismatch");
  assertRecipientSets(proof.cc, cc, "group_outlook_cc_mismatch");
  assertRecipientSets(proof.bcc, [], "group_outlook_bcc_forbidden");
}

function assertGroupEmailSendProof(proof, { senderAccount, to, cc }) {
  exactKeys(proof, [
    "ok", "client", "clientBundleId", "from", "to", "cc", "bcc", "messageId",
    "sourceAccountProven", "noSenderFallback", "explicitRecipientsOnly",
  ], "group email send proof");
  if (proof.ok !== true || proof.client !== OUTLOOK_CLIENT || proof.clientBundleId !== OUTLOOK_BUNDLE_ID
      || proof.sourceAccountProven !== true || proof.noSenderFallback !== true
      || proof.explicitRecipientsOnly !== true) throw coded("group_email_send_unconfirmed");
  if (normalizeEmail(proof.from) !== senderAccount) throw coded("group_email_send_source_mismatch");
  assertRecipientSets(proof.to, to, "group_email_send_to_mismatch");
  assertRecipientSets(proof.cc, cc, "group_email_send_cc_mismatch");
  assertRecipientSets(proof.bcc, [], "group_email_send_bcc_forbidden");
  const messageId = String(proof.messageId ?? "").trim();
  if (!messageId) throw coded("group_email_send_message_id_missing");
  return Object.freeze({ messageId });
}

function validateProfileSet(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 50) throw coded("group_email_authorizations_invalid");
  const profiles = input.map(validatePersonEmailAuthorization);
  if (new Set(profiles.map((item) => item.profileId)).size !== profiles.length
      || new Set(profiles.map((item) => item.principal.handle)).size !== profiles.length) {
    throw coded("group_email_authorizations_ambiguous");
  }
  return profiles;
}

function uniqueProfileForHandle(profiles, handle) {
  const matches = profiles.filter((profile) => profile.principal.handle === handle);
  if (matches.length !== 1) throw coded("group_actor_profile_unavailable");
  return matches[0];
}

function validateDirective(input) {
  const value = requireObject(input, "group recipient directive");
  exactKeys(value, ["role", "mention"], "group recipient directive");
  if (value.role !== "to" && value.role !== "cc") throw coded("group_recipient_role_invalid");
  const mention = safeDisplayName(value.mention);
  if (!mention || [...mention].length > 100) throw coded("group_recipient_mention_invalid");
  return Object.freeze({ role: value.role, mention });
}

function mentionMatchesProfile(mention, profile) {
  const query = mention.toLocaleLowerCase("en-US");
  const name = safeDisplayName(profile.displayName).toLocaleLowerCase("en-US");
  const parts = name.split(/\s+/u).filter(Boolean);
  return query === name || parts.includes(query);
}

function literalMentionPresent(body, mention) {
  const escaped = mention.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "iu").test(body);
}

function normalizeGroupTarget(input) {
  const raw = String(input ?? "").normalize("NFC").trim();
  if (!GROUP_TARGET.test(raw)) return "";
  const separator = raw.indexOf(":");
  return `${raw.slice(0, separator).toLowerCase()}:${raw.slice(separator + 1)}`;
}

function assertRecipientSets(actual, expected, code) {
  if (!Array.isArray(actual)) throw coded(code);
  const normalized = actual.map(normalizeEmail);
  if (normalized.some((item) => !item) || normalized.length !== expected.length || !sameSet(normalized, expected)) {
    throw coded(code);
  }
}

function sameSet(left, right) {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function validatePrincipalAdapter(adapter) {
  if (!adapter || typeof adapter.verifyInboundPrincipal !== "function") throw coded("group_principal_adapter_missing");
  return adapter;
}

function validateOutlookAdapter(adapter) {
  if (!adapter || typeof adapter.preflightEmailSend !== "function" || typeof adapter.sendEmail !== "function") {
    throw coded("group_outlook_adapter_missing");
  }
  return adapter;
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw coded(`${label.replaceAll(" ", "_")}_invalid`);
  return value;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw coded(`${label.replaceAll(" ", "_")}_invalid`);
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw coded(`${label.replaceAll(" ", "_")}_fields_invalid`);
  }
}

function safeErrorCode(error) {
  return String(error?.code ?? error?.name ?? "unknown").toLowerCase().replace(/[^a-z0-9_-]+/gu, "_").slice(0, 80) || "unknown";
}

function coded(code) {
  return new RicoEmailPolicyError(code);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
