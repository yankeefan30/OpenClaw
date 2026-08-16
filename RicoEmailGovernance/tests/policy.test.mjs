import assert from "node:assert/strict";
import test from "node:test";
import {
  ALLOWED_SENDER_ACCOUNTS,
  EMAIL_SIGNATURE,
  MEETING_REQUEST_REPLY,
} from "../definition.mjs";
import {
  assertNoPrivateProvenanceDisclosure,
  assertToolActionAllowed,
  isMeetingRequest,
  normalizeIMessageHandle,
  signedEmailBody,
  validateDetailedDraft,
  validateMeetingHandoffGrant,
  validatePersonEmailAuthorization,
} from "../policy.mjs";
import { detailedDraft, meetingGrant, personAuthorization } from "./fixtures.mjs";

test("person authorization binds one exact iMessage principal, contact email, sender, and Outlook", () => {
  const result = validatePersonEmailAuthorization(personAuthorization({
    principal: { handle: "(214) 555-0123" },
    email: { recipientEmail: "JANET@EXAMPLE.COM", senderAccount: "ALAN.A.ROSA@GMAIL.COM" },
  }));
  assert.equal(result.principal.handle, "+12145550123");
  assert.equal(result.email.recipientEmail, "janet@example.com");
  assert.equal(result.email.recipientSource.kind, "macos-contacts-reviewed-email");
  assert.equal(result.email.recipientSource.contactIdentifierHash, result.contactIdentifierHash);
  assert.equal(result.email.senderAccount, "alan.a.rosa@gmail.com");
  assert.equal(result.email.client, "outlook");
});

test("canonical Swift principal and strict legacy migration normalize to one internal principal", () => {
  const canonical = validatePersonEmailAuthorization(personAuthorization({
    principal: { kind: "phone", handle: "+1 (214) 555-0123" },
  }));
  const legacy = validatePersonEmailAuthorization(personAuthorization({
    principal: { channel: "imessage", kind: "direct", handle: "+1 (214) 555-0123" },
  }));
  assert.deepEqual(canonical.principal, { channel: "imessage", kind: "direct", handle: "+12145550123" });
  assert.deepEqual(legacy.principal, canonical.principal);
  assert.throws(() => validatePersonEmailAuthorization(personAuthorization({
    principal: { kind: "email", handle: "+12145550123" },
  })), /profile_principal_kind_mismatch/u);
  assert.throws(() => validatePersonEmailAuthorization(personAuthorization({
    principal: { kind: "phone", handle: "+12145550123", displayName: "Janet" },
  })), /principal_fields_invalid/u);
});

test("only the two owner-approved sender accounts are valid", () => {
  assert.deepEqual(ALLOWED_SENDER_ACCOUNTS, ["alan.a.rosa@gmail.com", "alan.rosa@cvshealth.com"]);
  assert.throws(() => validatePersonEmailAuthorization(personAuthorization({
    email: { senderAccount: "alias@example.com" },
  })), /email_sender_not_allowed/u);
});

test("email and attachment permissions are separate and fail closed", () => {
  assert.throws(() => validatePersonEmailAuthorization(personAuthorization({
    email: { enabled: false, attachmentsAllowed: true },
  })), /attachments_require_email_permission/u);
  assert.throws(() => validatePersonEmailAuthorization(personAuthorization({
    email: { enabled: true, recipientEmail: null },
  })), /email_authority_incomplete/u);
});

test("disabled profile may retain a reviewed destination and sender but grants no send authority", () => {
  const value = validatePersonEmailAuthorization(personAuthorization({ email: { enabled: false, attachmentsAllowed: false } }));
  assert.equal(value.email.enabled, false);
  assert.equal(value.email.recipientEmail, "janet@example.com");
});

test("unknown authorization fields are rejected", () => {
  assert.throws(() => validatePersonEmailAuthorization({ ...personAuthorization(), modelMayChooseSender: true }), /fields_invalid/u);
  const value = personAuthorization();
  value.email.freeTextRecipient = "attacker@example.com";
  assert.throws(() => validatePersonEmailAuthorization(value), /fields_invalid/u);
});

test("recipient must carry a reviewed macOS Contacts proof bound to the same contact and exact email", () => {
  const missing = personAuthorization();
  missing.email.recipientSource = null;
  assert.throws(() => validatePersonEmailAuthorization(missing), /email_recipient_source_invalid/u);
  const wrongContact = personAuthorization();
  wrongContact.email.recipientSource.contactIdentifierHash = "d".repeat(64);
  assert.throws(() => validatePersonEmailAuthorization(wrongContact), /email_recipient_contact_mismatch/u);
  const wrongEmail = personAuthorization();
  wrongEmail.email.recipientSource.emailValueHash = "e".repeat(64);
  assert.throws(() => validatePersonEmailAuthorization(wrongEmail), /email_recipient_value_mismatch/u);
});

test("meeting grant is exact-recipient, Outlook-only, and needs an approved source when enabled", () => {
  assert.equal(validateMeetingHandoffGrant(meetingGrant()).janetEmail, "janet.cummings@cvshealth.com");
  assert.throws(() => validateMeetingHandoffGrant(meetingGrant({ janetEmail: "other@example.com" })), /recipient_mismatch/u);
  assert.throws(() => validateMeetingHandoffGrant(meetingGrant({ client: "apple-mail" })), /client_must_be_outlook/u);
  assert.throws(() => validateMeetingHandoffGrant(meetingGrant({ senderAccount: null })), /sender_required/u);
});

test("meeting intent requires both a setup action and a meeting object", () => {
  assert.equal(isMeetingRequest("Rico, please schedule a meeting next week."), true);
  assert.equal(isMeetingRequest("Could you send a meeting invite?"), true);
  assert.equal(isMeetingRequest("What meetings are on Alan's calendar?"), false);
  assert.equal(isMeetingRequest("Please schedule the nightly database backup."), false);
});

test("calendar reads remain possible but every meeting/calendar mutation is denied", () => {
  assert.equal(assertToolActionAllowed({ tool: "outlook_calendar", operation: "list events" }), true);
  assert.throws(() => assertToolActionAllowed({ tool: "outlook_calendar", operation: "create event" }), /meeting_calendar_mutation_denied/u);
  assert.throws(() => assertToolActionAllowed({ tool: "meetings", operation: "reschedule appointment" }), /meeting_calendar_mutation_denied/u);
});

test("draft validator requires detailed copy and reserves signature ownership for enforcement", () => {
  assert.throws(() => validateDetailedDraft(detailedDraft({ body: "Short note." })), /email_body_not_detailed/u);
  assert.throws(() => validateDetailedDraft(detailedDraft({ body: `A detailed body with adequate explanation and supporting context. ${EMAIL_SIGNATURE}` })), /signature_must_be_enforcement_owned/u);
  assert.throws(() => validateDetailedDraft(detailedDraft({ body: "This contains enough detailed text to satisfy length, but it still has {{INSERT FACTS}} and must be rejected before sending." })), /unresolved_instruction/u);
  assert.throws(() => validateDetailedDraft(detailedDraft({ subject: "Safe-looking\u202Egnp.exe" })), /email_subject_invalid/u);
  assert.throws(() => validateDetailedDraft(detailedDraft({ subject: "Injected\nBcc: attacker@example.com" })), /email_subject_invalid/u);
});

test("enforcement appends the user-supplied signature literally and exactly once", () => {
  const body = signedEmailBody(detailedDraft().body);
  assert.equal(body.endsWith(EMAIL_SIGNATURE), true);
  assert.equal(body.split(EMAIL_SIGNATURE).length - 1, 1);
  assert.equal(EMAIL_SIGNATURE, "Rico an Autonmous Agent on behalf of Alan Rosa");
  assert.equal(MEETING_REQUEST_REPLY, "I can't set up meetings directly only Janet Cummings can do that but what I can do is send Janet an text message now that you have asked me to set up a meeting and that she should connect with you to make arrangements");
});

test("texts and emails can use private context but never disclose or obfuscate its provenance", () => {
  const blocked = [
    "I found that in Limitless.",
    "According to your PLAUD recording, the deadline is Friday.",
    "Based on our previous conversation, you prefer Tuesday.",
    "I reviewed your meeting transcript.",
    "In our chat last month, you preferred Tuesday.",
    "As we discussed, the deadline is Friday.",
    "When we last spoke, you preferred Tuesday.",
    "Our earlier conversation was useful.",
    "We talked about the deadline.",
    "You told me the deadline was Friday.",
    "Earlier, you said the deadline was Friday.",
    "I remember that you wanted a concise answer.",
    "I have access to your call recordings.",
    "I reviewed our previous conversation.",
    "Notes from our meeting identify the owner.",
    "Your Slack messages show that the deadline changed.",
    "I checked Outlook before answering.",
    "I searched your email for the date.",
    "I found this in Alan's Outlook mailbox.",
    "I found this in L\u200Bimitless.",
    "P L A U D supplied the detail.",
  ];
  for (const content of blocked) {
    assert.throws(() => assertNoPrivateProvenanceDisclosure(content), /private_context_provenance_disclosure_denied/u, content);
  }
});

test("the email provenance gate allows ordinary meeting and verified public-source language", () => {
  for (const content of [
    "The public court opinion supports this conclusion.",
    "The published court transcript explains the judge's ruling.",
    "Please ask Janet to arrange a meeting for Tuesday.",
    "A conversation is sometimes the fastest way to resolve a misunderstanding.",
    "We should talk about the public ruling.",
    "Your exchange rate calculation is correct.",
    "Your discussion question is well framed.",
    "Apple Mail is a registered trademark.",
    "The New York Times article supports this conclusion: https://www.nytimes.com/example",
  ]) assert.equal(assertNoPrivateProvenanceDisclosure(content), true, content);
});

test("phone and email handles normalize without accepting display names", () => {
  assert.equal(normalizeIMessageHandle("imessage:+1 (214) 555-0123"), "+12145550123");
  assert.equal(normalizeIMessageHandle("Person@Example.COM"), "person@example.com");
  assert.equal(normalizeIMessageHandle("Janet Cummings"), "");
});
