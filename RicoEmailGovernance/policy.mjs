import { createHash } from "node:crypto";
import {
  ALLOWED_SENDER_ACCOUNTS,
  EMAIL_SIGNATURE,
  MEETING_HANDOFF_RECIPIENT,
  OUTLOOK_CLIENT,
} from "./definition.mjs";

const PROFILE_SCHEMA = "rico.person-email-authorization";
const MEETING_GRANT_SCHEMA = "rico.meeting-handoff-grant";
const SIMPLE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const FORBIDDEN_DRAFT_MARKERS = /(?:\{\{[^}]+\}\}|\[\s*(?:insert|todo|tbd|placeholder)[^\]]*\]|(?:system|developer|assistant)\s*:)/iu;
const PRIVATE_PROVENANCE_PATTERNS = [
  /\b(?:l[\s._-]*i[\s._-]*m[\s._-]*i[\s._-]*t[\s._-]*l[\s._-]*e[\s._-]*s[\s._-]*s|p[\s._-]*l[\s._-]*a[\s._-]*u[\s._-]*d)\b/iu,
  /\b(?:life\s*-?\s*log|recorded\s+(?:conversation|meeting|call)|(?:conversation|meeting|call|audio|voice)\s+recording|meeting\s+transcript|(?:notes?|minutes)\s+from\s+(?:(?:our|your|the|a|an)\s+)?(?:(?:prior|previous|past|earlier|private)\s+)?(?:conversation|chat|discussion|meeting|call))\b/iu,
  /\b(?:(?:our|your)\s+(?:(?:prior|previous|past|earlier|private)\s+)?|the\s+(?:prior|previous|past|earlier|private)\s+)(?:conversation|chat)\b/iu,
  /\b(?:from|based\s+on|according\s+to|during|in|after|following)\s+(?:(?:our|your|the|a|an)\s+)?(?:(?:prior|previous|past|earlier|recorded|private)\s+)?(?:conversation|chat|exchange|discussion|messages?|recording|transcript)\b/iu,
  /\b(?:as\s+(?:we|you|he|she|they)\s+(?:discussed|talked|spoke|said|mentioned|shared|explained|agreed|noted|covered)|when\s+(?:we|you\s+and\s+i)\s+(?:last\s+)?(?:spoke|talked|chatted|met|discussed)|the\s+last\s+time\s+(?:we|you\s+and\s+i)\s+(?:spoke|talked|chatted|met|discussed)|(?:we|you\s+and\s+i)\s+(?:previously\s+)?(?:talked|spoke|chatted|discussed)\s+(?:about|of))\b/iu,
  /\b(?:(?:you|he|she|they)\s+(?:(?:said|mentioned|shared|explained|noted)\s+(?:earlier|before|previously|in\s+(?:(?:our|your|the|a|an)\s+)?(?:(?:prior|previous|past|earlier|private)\s+)?(?:conversation|chat|exchange|discussion|messages?|meeting|call|recording))|told\s+(?:me|rico))|earlier\s*,?\s*(?:you|he|she|they)\s+(?:said|mentioned|shared|explained|noted)|(?:i|rico|we)\s+(?:remember|recall)\s+(?:that\s+)?(?:you|we|our|your|the|when))\b/iu,
  /\b(?:(?:according\s+to|from|based\s+on|per)\s+(?:(?:your|alan(?:'s)?|the)\s+)?(?:emails?|gmail|outlook(?:\s+(?:email|mailbox|messages?))?|apple\s+mail|slack(?:\s+messages?)?|google\s+drive(?:\s+(?:file|document))?|drive\s+file|mailbox|messages?|transcript)|(?:your|alan(?:'s)?|the)\s+(?:emails?|gmail|outlook(?:\s+(?:email|mailbox|messages?))?|apple\s+mail|slack(?:\s+messages?)?|google\s+drive(?:\s+(?:file|document))?|drive\s+file|mailbox|messages?|transcript)\s+(?:says?|shows?|indicates?|mentions?|states?|confirms?|reveals?))\b/iu,
  /\b(?:i|rico|we)\s+(?:(?:have|had|can|could|did)\s+)?(?:access(?:ed)?|open(?:ed)?|read|re-?read|review(?:ed)?|search(?:ed)?|check(?:ed)?|consult(?:ed)?|use(?:d)?)\s+(?:(?:your|alan(?:'s)?|the)\s+)?(?:emails?|gmail|outlook(?:\s+(?:email|mailbox|messages?))?|apple\s+mail|slack(?:\s+messages?)?|google\s+drive(?:\s+(?:file|document))?|drive\s+file|mailbox)\b/iu,
  /\b(?:i|rico|we)\s+(?:(?:(?:have|had|got|can|could)\s+access\s+to|(?:was|were)\s+able\s+to\s+access)\s+(?:our|your|the|a|an|alan(?:'s)?)\s+(?:(?:prior|previous|past|earlier|recorded|private)\s+)?(?:recordings?|conversations?|chats?|meetings?|calls?|lifelogs?|transcripts?|messages?)|(?:(?:have|had|can|could|did)\s+)?(?:access(?:ed)?|read|re-?read|revisit(?:ed)?|review(?:ed)?|listen(?:ed)?\s+to|hear(?:d)?|search(?:ed)?|check(?:ed)?|consult(?:ed)?|use(?:d)?)\s+(?:our|your|the|a|an|alan(?:'s)?)\s+(?:(?:prior|previous|past|earlier|recorded|private)\s+)?(?:recordings?|conversations?|chats?|meetings?|calls?|lifelogs?|transcripts?))\b/iu,
  /\b(?:i|rico|we)\s+(?:found|learned|saw|read|heard|pulled|got|confirmed)\s+(?:this|that|it|the\s+(?:detail|information|answer|date|fact))?\s*(?:from|in|through|by\s+(?:reading|reviewing|listening\s+to))\s+(?:(?:your|alan(?:'s)?|the)\s+)?(?:emails?|gmail|outlook(?:\s+(?:email|mailbox|messages?))?|apple\s+mail|slack(?:\s+messages?)?|google\s+drive(?:\s+(?:file|document))?|drive\s+file|mailbox|messages?|recording|transcript|lifelog)\b/iu,
];

export class RicoEmailPolicyError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "RicoEmailPolicyError";
    this.code = code;
  }
}

export function normalizeEmail(input) {
  const value = String(input ?? "").trim().toLowerCase();
  return value.length <= 254 && SIMPLE_EMAIL.test(value) ? value : "";
}

export function normalizeIMessageHandle(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  for (const prefix of ["imessage:", "sms:", "tel:", "mailto:"]) {
    if (lower.startsWith(prefix)) return normalizeIMessageHandle(raw.slice(prefix.length));
  }
  if (raw.includes("@")) return normalizeEmail(raw);
  const digits = raw.replace(/\D/gu, "");
  if (raw.startsWith("+")) return /^\+[1-9]\d{6,14}$/u.test(`+${digits}`) ? `+${digits}` : "";
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
}

export function safeDisplayName(input) {
  const value = String(input ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const cleaned = [...value.replace(/[^\p{L}\p{M}\p{N} '\u2019().,&-]/gu, "")].slice(0, 100).join("").trim();
  if (!cleaned || /(?:system|developer|assistant)\s*:/iu.test(cleaned)) return "";
  return cleaned;
}

export function validatePersonEmailAuthorization(input) {
  const value = requireObject(input, "person email authorization");
  exactKeys(value, ["schema", "schemaVersion", "profileId", "contactIdentifierHash", "displayName", "principal", "email", "revision", "authorizedAt"], "person email authorization");
  if (value.schema !== PROFILE_SCHEMA || value.schemaVersion !== 1) throw policyError("profile_schema_invalid");
  const profileId = String(value.profileId ?? "").trim();
  if (!PROFILE_ID.test(profileId)) throw policyError("profile_id_invalid");
  const contactIdentifierHash = String(value.contactIdentifierHash ?? "").trim().toLowerCase();
  if (!DIGEST.test(contactIdentifierHash)) throw policyError("profile_contact_identifier_invalid");
  const displayName = safeDisplayName(value.displayName);
  if (!displayName) throw policyError("profile_display_name_invalid");

  const principal = normalizePersonAuthorizationPrincipal(value.principal);
  const handle = principal.handle;

  const email = requireObject(value.email, "email authorization");
  exactKeys(email, ["enabled", "attachmentsAllowed", "recipientEmail", "recipientSource", "senderAccount", "client"], "email authorization");
  if (typeof email.enabled !== "boolean" || typeof email.attachmentsAllowed !== "boolean") throw policyError("email_flags_invalid");
  if (email.client !== OUTLOOK_CLIENT) throw policyError("email_client_must_be_outlook");
  if (!email.enabled && email.attachmentsAllowed) throw policyError("attachments_require_email_permission");
  const recipientEmail = email.recipientEmail === null ? null : normalizeEmail(email.recipientEmail);
  const senderAccount = email.senderAccount === null ? null : normalizeEmail(email.senderAccount);
  if (email.recipientEmail !== null && !recipientEmail) throw policyError("email_recipient_invalid");
  const recipientSource = validateRecipientSource(email.recipientSource, { recipientEmail, contactIdentifierHash });
  if (email.senderAccount !== null && !ALLOWED_SENDER_ACCOUNTS.includes(senderAccount)) throw policyError("email_sender_not_allowed");
  if (email.enabled && (!recipientEmail || !senderAccount)) throw policyError("email_authority_incomplete");

  const revision = Number(value.revision);
  if (!Number.isInteger(revision) || revision < 1 || revision > Number.MAX_SAFE_INTEGER) throw policyError("profile_revision_invalid");
  const authorizedAt = normalizeTimestamp(value.authorizedAt, "profile_authorized_at_invalid");
  return deepFreeze({
    schema: PROFILE_SCHEMA,
    schemaVersion: 1,
    profileId,
    contactIdentifierHash,
    displayName,
    principal: { channel: "imessage", kind: "direct", handle },
    email: { enabled: email.enabled, attachmentsAllowed: email.attachmentsAllowed, recipientEmail, recipientSource, senderAccount, client: OUTLOOK_CLIENT },
    revision,
    authorizedAt,
  });
}

/**
 * Studio's canonical v1 archive writes RicoPersonPrincipal as
 * `{kind:"phone|email",handle}`. Early governance fixtures used the internal
 * `{channel:"imessage",kind:"direct",handle}` shape. Accept the latter only
 * as a strict migration input and always normalize both forms to the same
 * internal direct-iMessage principal. Display names never enter this seam.
 */
export function normalizePersonAuthorizationPrincipal(input) {
  const value = requireObject(input, "principal");
  const keys = Object.keys(value).sort().join(",");
  if (keys === "handle,kind") {
    if (value.kind !== "phone" && value.kind !== "email") throw policyError("profile_principal_kind_invalid");
    const handle = normalizeIMessageHandle(value.handle);
    if (!handle) throw policyError("profile_principal_invalid");
    const actualKind = handle.includes("@") ? "email" : "phone";
    if (actualKind !== value.kind) throw policyError("profile_principal_kind_mismatch");
    return Object.freeze({ channel: "imessage", kind: "direct", handle });
  }
  if (keys === "channel,handle,kind") {
    if (value.channel !== "imessage" || value.kind !== "direct") throw policyError("profile_principal_invalid");
    const handle = normalizeIMessageHandle(value.handle);
    if (!handle) throw policyError("profile_principal_invalid");
    return Object.freeze({ channel: "imessage", kind: "direct", handle });
  }
  throw policyError("principal_fields_invalid");
}

function validateRecipientSource(input, { recipientEmail, contactIdentifierHash }) {
  if (recipientEmail === null) {
    if (input !== null) throw policyError("email_recipient_source_without_recipient");
    return null;
  }
  const value = requireObject(input, "email recipient source");
  exactKeys(value, ["kind", "contactIdentifierHash", "emailValueHash", "reviewedAt"], "email recipient source");
  if (value.kind !== "macos-contacts-reviewed-email") throw policyError("email_recipient_source_invalid");
  const sourceContactHash = String(value.contactIdentifierHash ?? "").trim().toLowerCase();
  const emailValueHash = String(value.emailValueHash ?? "").trim().toLowerCase();
  if (sourceContactHash !== contactIdentifierHash) throw policyError("email_recipient_contact_mismatch");
  if (emailValueHash !== sha256(recipientEmail)) throw policyError("email_recipient_value_mismatch");
  return Object.freeze({
    kind: "macos-contacts-reviewed-email",
    contactIdentifierHash: sourceContactHash,
    emailValueHash,
    reviewedAt: normalizeTimestamp(value.reviewedAt, "email_recipient_reviewed_at_invalid"),
  });
}

export function validateMeetingHandoffGrant(input) {
  const value = requireObject(input, "meeting handoff grant");
  exactKeys(value, ["schema", "schemaVersion", "enabled", "janetEmail", "senderAccount", "client", "issuedAt"], "meeting handoff grant");
  if (value.schema !== MEETING_GRANT_SCHEMA || value.schemaVersion !== 1) throw policyError("meeting_grant_schema_invalid");
  if (typeof value.enabled !== "boolean") throw policyError("meeting_grant_enabled_invalid");
  if (normalizeEmail(value.janetEmail) !== MEETING_HANDOFF_RECIPIENT) throw policyError("meeting_grant_recipient_mismatch");
  if (value.client !== OUTLOOK_CLIENT) throw policyError("meeting_grant_client_must_be_outlook");
  const senderAccount = value.senderAccount === null ? null : normalizeEmail(value.senderAccount);
  if (value.senderAccount !== null && !ALLOWED_SENDER_ACCOUNTS.includes(senderAccount)) throw policyError("meeting_grant_sender_not_allowed");
  if (value.enabled && !senderAccount) throw policyError("meeting_grant_sender_required");
  return deepFreeze({
    schema: MEETING_GRANT_SCHEMA,
    schemaVersion: 1,
    enabled: value.enabled,
    janetEmail: MEETING_HANDOFF_RECIPIENT,
    senderAccount,
    client: OUTLOOK_CLIENT,
    issuedAt: normalizeTimestamp(value.issuedAt, "meeting_grant_issued_at_invalid"),
  });
}

export function validateInboundReference(input) {
  const value = requireObject(input, "inbound reference");
  exactKeys(value, ["messageId", "conversationId", "body"], "inbound reference");
  const messageId = exactText(value.messageId, "message_id_invalid", 512);
  const conversationId = exactText(value.conversationId, "conversation_id_invalid", 512);
  const body = exactText(value.body, "message_body_invalid", 4_000, { multiline: true });
  return deepFreeze({ messageId, conversationId, body, bodyHash: sha256(body) });
}

export function validateDetailedDraft(input) {
  const value = requireObject(input, "email draft");
  exactKeys(value, ["subject", "body", "attachments"], "email draft");
  const subject = exactText(value.subject, "email_subject_invalid", 160);
  const body = exactText(value.body, "email_body_invalid", 20_000, { multiline: true });
  if ([...body].length < 80) throw policyError("email_body_not_detailed");
  if (FORBIDDEN_DRAFT_MARKERS.test(subject) || FORBIDDEN_DRAFT_MARKERS.test(body)) throw policyError("email_draft_contains_unresolved_instruction");
  assertNoPrivateProvenanceDisclosure(`${subject}\n${body}`);
  if (/rico an auton(?:o)?mous agent on behalf of alan rosa/iu.test(body)) throw policyError("email_signature_must_be_enforcement_owned");
  if (!Array.isArray(value.attachments) || value.attachments.length > 5) throw policyError("email_attachments_invalid");
  return deepFreeze({ subject, body, attachments: value.attachments.map((item) => validateAttachmentDescriptor(item)) });
}

export function validateAttachmentDescriptor(input) {
  const value = requireObject(input, "attachment descriptor");
  exactKeys(value, ["path", "mime", "byteSize", "sha256"], "attachment descriptor");
  const filePath = String(value.path ?? "").trim();
  if (!filePath.startsWith("/") || filePath.length > 4_096 || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u.test(filePath)) throw policyError("attachment_path_invalid");
  const mime = String(value.mime ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/u.test(mime)) throw policyError("attachment_mime_invalid");
  const byteSize = Number(value.byteSize);
  if (!Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > 25 * 1024 * 1024) throw policyError("attachment_size_invalid");
  const digest = String(value.sha256 ?? "").trim().toLowerCase();
  if (!DIGEST.test(digest)) throw policyError("attachment_digest_invalid");
  return Object.freeze({ path: filePath, mime, byteSize, sha256: digest });
}

export function signedEmailBody(body) {
  const clean = exactText(body, "email_body_invalid", 20_000, { multiline: true }).trimEnd();
  assertNoPrivateProvenanceDisclosure(clean);
  if (/rico an auton(?:o)?mous agent on behalf of alan rosa/iu.test(clean)) throw policyError("email_signature_must_be_enforcement_owned");
  return `${clean}\n\n${EMAIL_SIGNATURE}`;
}

export function assertNoPrivateProvenanceDisclosure(content) {
  const value = String(content ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu, "")
    .replace(/\s+/gu, " ");
  if (PRIVATE_PROVENANCE_PATTERNS.some((pattern) => pattern.test(value))) {
    throw policyError("private_context_provenance_disclosure_denied");
  }
  return true;
}

export function isMeetingRequest(input) {
  const text = String(input ?? "").normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
  if (!text || text.length > 4_000) return false;
  const meetingObject = /\b(meeting|appointment|call|conference|video call|zoom|teams call|time to (?:meet|talk|speak))\b/u;
  const setupAction = /\b(schedule|book|arrange|set\s*up|coordinate|organize|reschedule|move|cancel|invite|send\s+(?:me\s+)?an?\s+invite|find\s+(?:a\s+)?time)\b/u;
  return meetingObject.test(text) && setupAction.test(text);
}

export function assertToolActionAllowed({ tool, operation = "" }) {
  const joined = `${String(tool ?? "")} ${String(operation ?? "")}`.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
  if (!joined) throw policyError("tool_action_invalid");
  const calendarObject = /\b(calendar|event|meeting|appointment|invite)\b/u.test(joined);
  const mutation = /\b(create|insert|add|update|edit|modify|reschedule|schedule|book|arrange|move|cancel|delete|remove|invite|accept|decline|respond)\b/u.test(joined);
  if (calendarObject && mutation) throw policyError("meeting_calendar_mutation_denied");
  return true;
}

export function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw policyError(`${label.replaceAll(" ", "_")}_invalid`);
  return value;
}

function exactKeys(value, keys, label) {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) throw policyError(`${label.replaceAll(" ", "_")}_fields_invalid`);
}

function exactText(input, code, maxCharacters, { multiline = false } = {}) {
  const value = String(input ?? "").normalize("NFC").replace(/\r\n/gu, "\n").trim();
  if (!value || [...value].length > maxCharacters
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u.test(value)
    || /\r/u.test(value)
    || (!multiline && /\n/u.test(value))) {
    throw policyError(code);
  }
  return value;
}

function normalizeTimestamp(input, code) {
  const timestamp = Date.parse(String(input ?? ""));
  if (!Number.isFinite(timestamp)) throw policyError(code);
  return new Date(timestamp).toISOString();
}

function policyError(code) {
  return new RicoEmailPolicyError(code);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
