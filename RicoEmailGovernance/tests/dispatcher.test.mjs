import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { AuthorizedPersonEmailDispatcher } from "../dispatcher.mjs";
import { EMAIL_SIGNATURE, OUTLOOK_BUNDLE_ID } from "../definition.mjs";
import { detailedDraft, harness, inbound, personAuthorization } from "./fixtures.mjs";

test("authorized email uses the exact profile recipient and Gmail source through proven Outlook", async (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const dispatcher = new AuthorizedPersonEmailDispatcher({ adapter: h.adapter, ledger: h.ledger });
  const result = await dispatcher.send({ inbound: inbound({ body: "Rico, please send me a complete technical email about the reviewed matter." }), authorization: h.profile, draft: detailedDraft() });
  assert.equal(result.status, "sent");
  assert.equal(h.calls.verify.length, 1);
  assert.equal(h.calls.emailPreflight.length, 1);
  assert.equal(h.calls.sendEmail.length, 1);
  const sent = h.calls.sendEmail[0];
  assert.equal(sent.client, "outlook");
  assert.equal(sent.clientBundleId, OUTLOOK_BUNDLE_ID);
  assert.equal(sent.from, "alan.a.rosa@gmail.com");
  assert.equal(sent.to, "janet@example.com");
  assert.deepEqual(sent.cc, []);
  assert.deepEqual(sent.bcc, []);
  assert.equal(sent.noSenderFallback, true);
  assert.equal(sent.requireSourceAccountProof, true);
  assert.equal(sent.text.endsWith(EMAIL_SIGNATURE), true);
  assert.match(sent.idempotencyKey, /^rico-person-email:[a-f0-9]{64}$/u);
  const persisted = fs.readFileSync(h.ledger.claimPath(result.requestKey, "person-email"), "utf8");
  assert.equal(persisted.includes("janet@example.com"), false);
  assert.equal(persisted.includes("alan.a.rosa@gmail.com"), false);
  assert.equal(persisted.includes(h.profile.principal.handle), false);
});

test("CVS sender selection is exact and never falls back to Gmail", async (t) => {
  const profile = personAuthorization({ email: { senderAccount: "alan.rosa@cvshealth.com" } });
  const h = harness({ profile });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const dispatcher = new AuthorizedPersonEmailDispatcher({ adapter: h.adapter, ledger: h.ledger });
  const result = await dispatcher.send({ inbound: inbound(), authorization: profile, draft: detailedDraft() });
  assert.equal(result.status, "sent");
  assert.equal(h.calls.emailPreflight[0].senderAccount, "alan.rosa@cvshealth.com");
  assert.equal(h.calls.sendEmail[0].from, "alan.rosa@cvshealth.com");
});

test("disabled email permission blocks before identity, Outlook, or file access", async (t) => {
  const profile = personAuthorization({ email: { enabled: false, attachmentsAllowed: false } });
  const h = harness({ profile });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const dispatcher = new AuthorizedPersonEmailDispatcher({ adapter: h.adapter, ledger: h.ledger });
  await assert.rejects(dispatcher.send({ inbound: inbound(), authorization: profile, draft: detailedDraft() }), /profile_email_disabled/u);
  assert.deepEqual(h.calls.verify, []);
  assert.deepEqual(h.calls.emailPreflight, []);
  assert.deepEqual(h.calls.sendEmail, []);
});

test("spoofed display name cannot substitute for the exact principal proof", async (t) => {
  const h = harness({
    verifyInboundPrincipal: async (request) => ({
      ok: true,
      channel: "imessage",
      direction: "inbound",
      direct: true,
      messageId: request.messageId,
      conversationId: request.conversationId,
      senderHandle: "+12145559999",
      bodyHash: request.expectedBodyHash,
      receivedAt: "2026-08-15T16:30:00.000Z",
      authenticationSource: "openclaw-gateway-exact-principal",
    }),
  });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const dispatcher = new AuthorizedPersonEmailDispatcher({ adapter: h.adapter, ledger: h.ledger });
  await assert.rejects(dispatcher.send({ inbound: inbound(), authorization: h.profile, draft: detailedDraft() }), /inbound_principal_mismatch/u);
  assert.equal(h.calls.emailPreflight.length, 0);
  assert.equal(h.calls.sendEmail.length, 0);
});

test("wrong Outlook source proof fails before reservation and can be retried after repair", async (t) => {
  const h = harness({
    preflightEmailSend: async (request) => ({
      ok: true,
      client: "outlook",
      clientBundleId: OUTLOOK_BUNDLE_ID,
      senderAccount: "alan.rosa@cvshealth.com",
      recipient: request.recipient,
      outlookClientProven: true,
      sourceAccountProven: true,
      recipientProven: true,
      noSenderFallback: true,
      idempotentSends: true,
      attachmentsSupported: true,
    }),
  });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const dispatcher = new AuthorizedPersonEmailDispatcher({ adapter: h.adapter, ledger: h.ledger });
  await assert.rejects(dispatcher.send({ inbound: inbound(), authorization: h.profile, draft: detailedDraft() }), /outlook_source_account_mismatch/u);
  assert.equal(h.calls.sendEmail.length, 0);
  assert.equal(fs.readdirSync(h.ledger.directory).length, 0);
});

test("attachment permission is separately enforced before any principal or send call", async (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const dispatcher = new AuthorizedPersonEmailDispatcher({ adapter: h.adapter, ledger: h.ledger });
  const draft = detailedDraft({ attachments: [{ path: "/tmp/evidence.pdf", mime: "application/pdf", byteSize: 10, sha256: "a".repeat(64) }] });
  await assert.rejects(dispatcher.send({ inbound: inbound(), authorization: h.profile, draft }), /profile_attachments_disabled/u);
  assert.equal(h.calls.verify.length, 0);
  assert.equal(h.calls.sendEmail.length, 0);
});

test("approved attachment is rehashed, size-checked, and constrained to an allowed root", async (t) => {
  const profile = personAuthorization({ email: { attachmentsAllowed: true } });
  const h = harness({ profile });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const attachmentsRoot = path.join(h.root, "approved-attachments");
  fs.mkdirSync(attachmentsRoot, { mode: 0o700 });
  const filePath = path.join(attachmentsRoot, "evidence.pdf");
  fs.writeFileSync(filePath, "reviewed evidence", { mode: 0o600 });
  const data = fs.readFileSync(filePath);
  const draft = detailedDraft({ attachments: [{
    path: filePath,
    mime: "application/pdf",
    byteSize: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  }] });
  const dispatcher = new AuthorizedPersonEmailDispatcher({ adapter: h.adapter, ledger: h.ledger, allowedAttachmentRoots: [attachmentsRoot] });
  const result = await dispatcher.send({ inbound: inbound(), authorization: profile, draft });
  assert.equal(result.status, "sent");
  assert.equal(h.calls.sendEmail[0].attachments.length, 1);
  assert.equal(h.calls.sendEmail[0].attachments[0].path, fs.realpathSync(filePath));
  assert.equal(h.calls.sendEmail[0].attachments[0].filename, "evidence.pdf");
});

test("an attachment outside the reviewed root fails after preflight but before send", async (t) => {
  const profile = personAuthorization({ email: { attachmentsAllowed: true } });
  const h = harness({ profile });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const allowed = path.join(h.root, "allowed");
  const outside = path.join(h.root, "outside");
  fs.mkdirSync(allowed, { mode: 0o700 });
  fs.mkdirSync(outside, { mode: 0o700 });
  const filePath = path.join(outside, "private.pdf");
  fs.writeFileSync(filePath, "private", { mode: 0o600 });
  const data = fs.readFileSync(filePath);
  const draft = detailedDraft({ attachments: [{ path: filePath, mime: "application/pdf", byteSize: data.length, sha256: createHash("sha256").update(data).digest("hex") }] });
  const dispatcher = new AuthorizedPersonEmailDispatcher({ adapter: h.adapter, ledger: h.ledger, allowedAttachmentRoots: [allowed] });
  await assert.rejects(dispatcher.send({ inbound: inbound(), authorization: profile, draft }), /attachment_outside_allowed_roots/u);
  assert.equal(h.calls.sendEmail.length, 0);
});

test("unconfirmed send is quarantined and replay cannot send again", async (t) => {
  const h = harness({
    sendEmail: async (request) => ({
      ok: true,
      client: "outlook",
      clientBundleId: OUTLOOK_BUNDLE_ID,
      from: "alan.rosa@cvshealth.com",
      to: request.to,
      messageId: "possibly-sent",
      sourceAccountProven: false,
      noSenderFallback: true,
    }),
  });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const dispatcher = new AuthorizedPersonEmailDispatcher({ adapter: h.adapter, ledger: h.ledger });
  const first = await dispatcher.send({ inbound: inbound(), authorization: h.profile, draft: detailedDraft() });
  assert.equal(first.status, "outcome-unknown");
  const second = await dispatcher.send({ inbound: inbound(), authorization: h.profile, draft: detailedDraft() });
  assert.equal(second.status, "already-claimed");
  assert.equal(h.calls.sendEmail.length, 1);
});
