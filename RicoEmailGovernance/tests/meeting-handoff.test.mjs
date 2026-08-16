import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  EMAIL_SIGNATURE,
  MEETING_HANDOFF_RECIPIENT,
  MEETING_REQUEST_REPLY,
  OUTLOOK_BUNDLE_ID,
} from "../definition.mjs";
import { MeetingHandoffEngine } from "../meeting-handoff.mjs";
import { harness, inbound, meetingGrant, personAuthorization } from "./fixtures.mjs";

test("meeting request gets the exact reply and one detailed Outlook handoff to Janet", async (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const engine = new MeetingHandoffEngine({ adapter: h.adapter, ledger: h.ledger, permissionGrant: h.grant });
  const result = await engine.handle({ inbound: inbound(), authorization: h.profile });
  assert.equal(result.status, "completed");
  assert.equal(result.requesterReply, "confirmed");
  assert.equal(result.janetEmail, "confirmed");
  assert.equal(h.calls.reply.length, 1);
  assert.equal(h.calls.reply[0].text, MEETING_REQUEST_REPLY);
  assert.equal(h.calls.reply[0].sameThreadRequired, true);
  assert.equal(h.calls.reply[0].conversationId, inbound().conversationId);
  assert.equal(h.calls.sendEmail.length, 1);
  const sent = h.calls.sendEmail[0];
  assert.equal(sent.client, "outlook");
  assert.equal(sent.clientBundleId, OUTLOOK_BUNDLE_ID);
  assert.equal(sent.from, "alan.rosa@cvshealth.com");
  assert.equal(sent.to, MEETING_HANDOFF_RECIPIENT);
  assert.equal(sent.subject, "Meeting has been requested by Janet Cummings");
  assert.match(sent.text, /Janet Cummings requested that a meeting be arranged/u);
  assert.match(sent.text, /August 15, 2026/u);
  assert.match(sent.text, /Please reach out directly to Janet Cummings/u);
  assert.match(sent.text, /has not created, modified, or represented that any calendar event exists/u);
  assert.equal(sent.text.endsWith(EMAIL_SIGNATURE), true);
  assert.deepEqual(sent.attachments, []);
});

test("meeting handoff authority is independent of permission to email the requester", async (t) => {
  const profile = personAuthorization({ email: { enabled: false, attachmentsAllowed: false } });
  const h = harness({ profile });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const engine = new MeetingHandoffEngine({ adapter: h.adapter, ledger: h.ledger, permissionGrant: h.grant });
  const result = await engine.handle({ inbound: inbound(), authorization: profile });
  assert.equal(result.status, "completed");
  assert.equal(h.calls.sendEmail[0].to, MEETING_HANDOFF_RECIPIENT);
});

test("disabled meeting grant fails closed without reading or sending", async (t) => {
  const h = harness({ grant: meetingGrant({ enabled: false, senderAccount: null }) });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const engine = new MeetingHandoffEngine({ adapter: h.adapter, ledger: h.ledger, permissionGrant: h.grant });
  await assert.rejects(engine.handle({ inbound: inbound(), authorization: h.profile }), /meeting_handoff_disabled/u);
  assert.equal(h.calls.verify.length, 0);
  assert.equal(h.calls.reply.length, 0);
  assert.equal(h.calls.sendEmail.length, 0);
});

test("non-meeting content is not routed to Janet", async (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const engine = new MeetingHandoffEngine({ adapter: h.adapter, ledger: h.ledger, permissionGrant: h.grant });
  await assert.rejects(engine.handle({ inbound: inbound({ body: "Rico, what meetings are on Alan's calendar?" }), authorization: h.profile }), /meeting_request_not_detected/u);
  assert.equal(h.calls.verify.length, 0);
  assert.equal(h.calls.reply.length, 0);
  assert.equal(h.calls.sendEmail.length, 0);
});

test("both Outlook and same-thread capabilities are proven before requester reply", async (t) => {
  const h = harness({
    preflightThreadReply: async (request) => ({
      ok: true,
      channel: "imessage",
      conversationId: request.conversationId,
      recipientHandle: "+12145559999",
      sameThread: true,
      idempotentReplies: true,
    }),
  });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const engine = new MeetingHandoffEngine({ adapter: h.adapter, ledger: h.ledger, permissionGrant: h.grant });
  await assert.rejects(engine.handle({ inbound: inbound(), authorization: h.profile }), /thread_reply_recipient_mismatch/u);
  assert.equal(h.calls.reply.length, 0);
  assert.equal(h.calls.sendEmail.length, 0);
  assert.equal(fs.readdirSync(h.ledger.directory).length, 0);
});

test("a replay cannot duplicate either the requester text or Janet email", async (t) => {
  const h = harness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const engine = new MeetingHandoffEngine({ adapter: h.adapter, ledger: h.ledger, permissionGrant: h.grant });
  await engine.handle({ inbound: inbound(), authorization: h.profile });
  const replay = await engine.handle({ inbound: inbound(), authorization: h.profile });
  assert.equal(replay.requesterReply, "already-claimed");
  assert.equal(replay.janetEmail, "already-claimed");
  assert.equal(h.calls.reply.length, 1);
  assert.equal(h.calls.sendEmail.length, 1);
});

test("uncertain requester reply does not suppress the independently authorized Janet email", async (t) => {
  const h = harness({
    replyInThread: async () => { throw Object.assign(new Error("timeout"), { code: "transport_timeout" }); },
  });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const engine = new MeetingHandoffEngine({ adapter: h.adapter, ledger: h.ledger, permissionGrant: h.grant });
  const result = await engine.handle({ inbound: inbound(), authorization: h.profile });
  assert.equal(result.status, "attention");
  assert.equal(result.requesterReply, "outcome-unknown");
  assert.equal(result.janetEmail, "confirmed");
  assert.equal(h.calls.reply.length, 1);
  assert.equal(h.calls.sendEmail.length, 1);
  await engine.handle({ inbound: inbound(), authorization: h.profile });
  assert.equal(h.calls.reply.length, 1);
  assert.equal(h.calls.sendEmail.length, 1);
});

test("uncertain Janet delivery is quarantined and never retried", async (t) => {
  const h = harness({
    sendEmail: async (request) => ({
      ok: true,
      client: "outlook",
      clientBundleId: OUTLOOK_BUNDLE_ID,
      from: request.from,
      to: request.to,
      messageId: "possibly-sent",
      sourceAccountProven: false,
      noSenderFallback: true,
    }),
  });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const engine = new MeetingHandoffEngine({ adapter: h.adapter, ledger: h.ledger, permissionGrant: h.grant });
  const result = await engine.handle({ inbound: inbound(), authorization: h.profile });
  assert.equal(result.janetEmail, "outcome-unknown");
  await engine.handle({ inbound: inbound(), authorization: h.profile });
  assert.equal(h.calls.sendEmail.length, 1);
});
