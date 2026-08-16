import assert from "node:assert/strict";
import test from "node:test";
import {
  GroupEmailToolExecutor,
  RICO_GROUP_EMAIL_TOOL_DEFINITION,
  RICO_GROUP_EMAIL_TOOL_NAME,
} from "../group-email-tool.mjs";
import { sha256 } from "../policy.mjs";
import { personAuthorization } from "./fixtures.mjs";

const BODY = "@rico email Janet with the complete technical summary and copy Joe and me.";

function authorization({ id, hash, name, handle, email }) {
  return personAuthorization({
    profileId: id,
    contactIdentifierHash: hash.repeat(64),
    displayName: name,
    principal: { kind: "phone", handle },
    email: { recipientEmail: email, senderAccount: "alan.rosa@cvshealth.com" },
  });
}

function authorizations() {
  return [
    authorization({ id: "person:janet", hash: "a", name: "Janet Cummings", handle: "+12145312001", email: "janet.cummings@cvshealth.com" }),
    authorization({ id: "person:joe", hash: "b", name: "Joe Example", handle: "+12125550120", email: "joe@example.com" }),
    authorization({ id: "person:alan", hash: "c", name: "Alan Rosa", handle: "+16469433060", email: "alan.a.rosa@gmail.com" }),
  ];
}

function origin(overrides = {}) {
  const body = overrides.body ?? BODY;
  return {
    ok: true,
    source: "rico-recipient-guard/v5",
    channel: "imessage",
    conversationType: "group",
    runId: "run-42",
    messageId: "message-42",
    conversationId: "conversation-42",
    groupTarget: "chat_id:42",
    groupRevision: 3,
    senderHandle: "+16469433060",
    body,
    bodyHash: sha256(body),
    ...overrides,
  };
}

function group(overrides = {}) {
  return {
    schema: "rico.group-email-authorization",
    schemaVersion: 1,
    target: "chat_id:42",
    participants: ["+16469433060", "+12125550120"],
    revision: 3,
    authorizedAt: "2026-08-15T18:00:00.000Z",
    ...overrides,
  };
}

function recipients() {
  return [
    { role: "to", profileId: "person:janet", displayName: "Janet Cummings", mention: "Janet" },
    { role: "cc", profileId: "person:joe", displayName: "Joe Example", mention: "Joe" },
    { role: "cc", profileId: "person:alan", displayName: "Alan Rosa", mention: "me" },
  ];
}

function fixture(overrides = {}) {
  const calls = { origin: [], email: [], meeting: [] };
  const broker = {
    send: async (request) => { calls.email.push(request); return { status: "sent", requestKey: "a".repeat(64) }; },
    sendMeetingHandoff: async (request) => { calls.meeting.push(request); return { status: "sent", requestKey: "b".repeat(64) }; },
  };
  const executor = new GroupEmailToolExecutor({
    broker,
    verifyRequestOrigin: async (runtimeContext) => {
      calls.origin.push(runtimeContext);
      return overrides.origin ?? origin();
    },
    authorizationProvider: { list: async () => overrides.authorizations ?? authorizations() },
    groupAuthorizationProvider: { get: async () => overrides.group ?? group() },
  });
  return { executor, calls };
}

function emailInput(overrides = {}) {
  return {
    action: "email",
    recipients: recipients(),
    subject: "Complete technical summary",
    body: "Janet — the complete technical summary follows with the relevant facts, limitations, and next steps stated precisely for a clear and reliable record.",
    attachments: [],
    ...overrides,
  };
}

test("tool definition exposes opaque profile selections but no raw address field", () => {
  assert.equal(RICO_GROUP_EMAIL_TOOL_NAME, "rico_group_email_execute");
  assert.equal(RICO_GROUP_EMAIL_TOOL_DEFINITION.name, RICO_GROUP_EMAIL_TOOL_NAME);
  const serialized = JSON.stringify(RICO_GROUP_EMAIL_TOOL_DEFINITION);
  assert.match(serialized, /profileId/u);
  assert.doesNotMatch(serialized, /recipientEmail|senderAccount|groupParticipants|bcc/iu);
});

test("executor binds trusted group origin and opaque profile selections to broker input", async () => {
  const h = fixture();
  const runtimeContext = { runId: "host-run-42", privateRegistryKey: "opaque" };
  const result = await h.executor.execute({ runtimeContext, input: emailInput() });
  assert.equal(result.status, "sent");
  assert.deepEqual(h.calls.origin, [runtimeContext]);
  assert.equal(h.calls.email.length, 1);
  assert.deepEqual(h.calls.email[0].inbound, {
    messageId: "message-42",
    conversationId: "conversation-42",
    body: BODY,
  });
  assert.deepEqual(h.calls.email[0].recipientDirectives, [
    { role: "to", mention: "Janet" },
    { role: "cc", mention: "Joe" },
    { role: "cc", mention: "me" },
  ]);
  assert.equal(h.calls.email[0].authorizations.length, 3);
});

test("model cannot inject a raw email address or sender account", async () => {
  const h = fixture();
  await assert.rejects(h.executor.execute({
    runtimeContext: {},
    input: { ...emailInput(), to: ["attacker@example.com"] },
  }), /group_email_tool_input_fields_invalid/u);
  await assert.rejects(h.executor.execute({
    runtimeContext: {},
    input: { ...emailInput(), senderAccount: "attacker@example.com" },
  }), /group_email_tool_input_fields_invalid/u);
  assert.equal(h.calls.origin.length, 0);
});

test("profile ID and reviewed display name must identify the same authorization", async () => {
  const h = fixture();
  const input = emailInput();
  input.recipients[0] = { ...input.recipients[0], displayName: "Janet Smith" };
  await assert.rejects(h.executor.execute({ runtimeContext: {}, input }), /group_email_tool_profile_mismatch/u);
  assert.equal(h.calls.email.length, 0);
});

test("first-name ambiguity fails closed even when the tool chose one opaque ID", async () => {
  const h = fixture({ authorizations: [...authorizations(), authorization({
    id: "person:other-janet", hash: "d", name: "Janet Smith", handle: "+12125550199", email: "other@example.com",
  })] });
  await assert.rejects(h.executor.execute({ runtimeContext: {}, input: emailInput() }), /group_email_tool_profile_ambiguous/u);
  assert.equal(h.calls.email.length, 0);
});

test("origin body hash and current group revision are mandatory", async () => {
  const invalidOrigin = origin({ bodyHash: "f".repeat(64) });
  const h1 = fixture({ origin: invalidOrigin });
  await assert.rejects(h1.executor.execute({ runtimeContext: {}, input: emailInput() }), /group_email_origin_body_mismatch/u);
  const h2 = fixture({ group: group({ revision: 4 }) });
  await assert.rejects(h2.executor.execute({ runtimeContext: {}, input: emailInput() }), /group_email_tool_group_revision_mismatch/u);
  assert.equal(h1.calls.email.length + h2.calls.email.length, 0);
});

test("meeting handoff accepts recipients only and cannot take model-written email content", async () => {
  const h = fixture({ origin: origin({ body: "@rico arrange a meeting through Janet and copy Joe and me.", bodyHash: sha256("@rico arrange a meeting through Janet and copy Joe and me.") }) });
  const result = await h.executor.execute({
    runtimeContext: {},
    input: { action: "meeting_handoff", recipients: recipients() },
  });
  assert.equal(result.status, "sent");
  assert.equal(h.calls.meeting.length, 1);
  await assert.rejects(h.executor.execute({
    runtimeContext: {},
    input: { action: "meeting_handoff", recipients: recipients(), subject: "Injected" },
  }), /group_email_tool_input_fields_invalid/u);
});
