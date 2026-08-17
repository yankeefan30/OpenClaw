import assert from "node:assert/strict";
import test from "node:test";
import { authorizeRecipient, parseSendTarget } from "../allowlist.mjs";
import { callTool } from "../tools.mjs";

function policy(identities, paused = false) {
  return { schemaVersion: 2, paused, identities };
}

const owner = {
  target: "+16469433060",
  kind: "individual",
  access: "owner",
  requireMention: false,
  autoReply: true,
  quietStart: 0,
  quietEnd: 0,
  directChatId: 99,
};

const contact = {
  target: "+15550000002",
  kind: "individual",
  access: "approved",
  requireMention: true,
  autoReply: true,
  quietStart: 0,
  quietEnd: 0,
};

const group = {
  target: "chat_id:24",
  kind: "group",
  access: "approved",
  requireMention: true,
  autoReply: true,
  quietStart: 0,
  quietEnd: 0,
  participants: ["+16469433060", "+15550000002"],
};

const blocked = {
  target: "+15550000099",
  kind: "individual",
  access: "blocked",
  requireMention: true,
  autoReply: false,
  quietStart: 0,
  quietEnd: 0,
};

test("parses E.164 and chat_id targets and rejects everything else", () => {
  assert.equal(parseSendTarget("+1 (646) 943-3060"), "+16469433060");
  assert.equal(parseSendTarget("chat_id:24"), "chat_id:24");
  assert.throws(() => parseSendTarget("stranger@example.com"), { code: "target_invalid" });
  assert.throws(() => parseSendTarget("not-a-target"), { code: "target_invalid" });
  assert.throws(() => parseSendTarget("chat_guid:abc"), { code: "target_invalid" });
});

test("allowlist accepts owner, approved contact, and approved group", () => {
  const current = policy([owner, contact, group, blocked]);
  assert.equal(authorizeRecipient({ policy: current, target: "+16469433060" }).ok, true);
  assert.equal(authorizeRecipient({ policy: current, target: "+15550000002" }).access, "approved");
  assert.equal(authorizeRecipient({ policy: current, target: "chat_id:24" }).kind, "group");
  assert.equal(authorizeRecipient({ policy: current, target: "chat_id:99" }).access, "owner");
});

test("approved contact chat ids match without a one-shot grant", () => {
  const jeff = { ...contact, target: "+18148814454", directChatId: 321, vip: true };
  const current = policy([owner, jeff]);
  assert.equal(authorizeRecipient({ policy: current, target: "+18148814454" }).access, "approved");
  assert.equal(authorizeRecipient({ policy: current, target: "chat_id:321" }).access, "approved");
});

test("allowlist rejects strangers, blocked identities, and paused policy", () => {
  const current = policy([owner, contact, group, blocked]);
  assert.throws(() => authorizeRecipient({ policy: current, target: "+15550000111" }), { code: "recipient_not_allowlisted" });
  assert.throws(() => authorizeRecipient({ policy: current, target: "+15550000099" }), { code: "recipient_not_allowlisted" });
  assert.throws(() => authorizeRecipient({ policy: current, target: "chat_id:404" }), { code: "recipient_not_allowlisted" });
  assert.throws(() => authorizeRecipient({ policy: policy([owner], true), target: "+16469433060" }), { code: "paused" });
});

test("native allowFrom cannot drop an already-approved identity", () => {
  const current = policy([owner, contact, group]);
  assert.equal(authorizeRecipient({
    policy: current,
    channel: { allowFrom: ["+16469433060"] },
    target: "+15550000002",
  }).access, "approved");
  assert.equal(authorizeRecipient({
    policy: current,
    channel: { allowFrom: ["+16469433060", "+15550000002"] },
    target: "+15550000002",
  }).ok, true);
  assert.equal(authorizeRecipient({
    policy: current,
    channel: { groups: { "7": { requireMention: true } } },
    target: "chat_id:24",
  }).kind, "group");
});

test("send tool rejects strangers without calling Gateway send", async () => {
  const calls = [];
  const runtime = {
    policy: policy([owner, contact]),
    channel: { allowFrom: ["+16469433060", "+15550000002"] },
    gateway: {
      async sendIMessage(request) {
        calls.push(request);
        return { ok: true, channel: "imessage", messageId: "msg-1" };
      },
    },
  };
  await assert.rejects(
    callTool(runtime, "rico_imessage_send", { to: "+15550000111", text: "hello" }),
    { code: "recipient_not_allowlisted" },
  );
  assert.equal(calls.length, 0);

  const allowed = await callTool(runtime, "rico_imessage_send", {
    to: "+16469433060",
    text: "hello from runner",
    idempotencyKey: "test-key-1",
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.messageId, "msg-1");
  assert.deepEqual(calls, [{
    to: "+16469433060",
    message: "hello from runner",
    idempotencyKey: "test-key-1",
  }]);
});

test("can_send checks the allowlist without calling Gateway send", async () => {
  const calls = [];
  const runtime = {
    policy: policy([owner, contact]),
    channel: { allowFrom: ["+16469433060", "+15550000002"] },
    gateway: {
      async sendIMessage(request) {
        calls.push(request);
        return { ok: true, channel: "imessage", messageId: "should-not-run" };
      },
    },
  };
  const allowed = await callTool(runtime, "rico_imessage_can_send", { to: "+16469433060" });
  assert.deepEqual(allowed, { ok: true, allowed: true, to: "+16469433060", kind: "direct" });
  await assert.rejects(
    callTool(runtime, "rico_imessage_can_send", { to: "+15550000111" }),
    { code: "recipient_not_allowlisted" },
  );
  assert.equal(calls.length, 0);
});
