import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  approvedDirectSystemPrompt,
  authorizeOutboundSend,
  createApprovedTargetMemory,
  decideIMessageSend,
  isForbiddenPublicSafeShrug,
  isInternalModelRoutingNotice,
  prepareIMessageOutboundContent,
  readPolicy,
  resolveSenderContext,
  senderIsolationApplied,
  sharedAudienceSystemPrompt,
  stripInternalModelRoutingText,
} from "./policy.js";
import {
  RICO_SHARED_LOCAL_MODEL,
  RICO_VIP_DIRECT_MODEL,
  resolveVipDirectModel,
  vipSessionModelIsClaude,
} from "./vip-route.js";

function policy(identities, paused = false) {
  return { schemaVersion: 2, paused, identities };
}

const jeff = {
  target: "+15555550111",
  kind: "individual",
  access: "approved",
  requireMention: false,
  autoReply: true,
  quietStart: 22,
  quietEnd: 8,
  displayName: "Jeff Roach",
};

const owner = {
  target: "+15555550001",
  kind: "individual",
  access: "owner",
  requireMention: false,
  autoReply: true,
  quietStart: 0,
  quietEnd: 0,
  directChatId: 570,
};

const group = {
  target: "chat_id:42",
  kind: "group",
  access: "approved",
  requireMention: true,
  autoReply: true,
  quietStart: 0,
  quietEnd: 0,
  participants: ["+15555550001", "+15555550111"],
};

const FALLBACK_NO_ARROW =
  "Model Fallback: anthropic/claude-opus-4-8 (selected lmstudio/qwen/qwen3.6-35b-a3b; timeout)";
const FALLBACK_ARROW =
  "↪️ Model Fallback: anthropic/claude-opus-4-8 (selected lmstudio/qwen/qwen3.6-35b-a3b; timeout)";
const PUBLIC_SAFE_SHRUG =
  "This is a shared, public-safe space. I don't have that. Please ask Alan directly.";

test("QA 1: unknown recipient is denied", () => {
  const current = policy([jeff, owner]);
  assert.deepEqual(authorizeOutboundSend({
    target: "+15555550999",
    policy: current,
  }), { allow: false, reason: "stranger" });
  assert.equal(decideIMessageSend({
    event: { to: "+15555550999", content: "hello from Rico" },
    policy: current,
  }).allow, false);
  assert.equal(decideIMessageSend({
    event: { to: "chat_id:404", content: "hello from Rico" },
    policy: current,
  }).reason, "stranger");
});

test("QA 2: approved VIP is allowed with empty grants and a throwing policy read", () => {
  const current = policy([jeff, owner]);
  const memory = createApprovedTargetMemory();
  memory.rememberPolicy(current);

  const emptyGrants = fs.mkdtempSync(path.join(os.tmpdir(), "rico-empty-grants-"));
  fs.chmodSync(emptyGrants, 0o700);

  const byHandle = decideIMessageSend({
    event: { to: "+1 (555) 555-0111", content: "Jeff, I am here." },
    policy: current,
    grantsDirectory: emptyGrants,
  });
  assert.equal(byHandle.allow, true);
  assert.equal(byHandle.reason, "approved_identity");

  const byChatIdMismatch = decideIMessageSend({
    event: {
      to: "chat_id:8811",
      content: "Jeff, I am here.",
      sessionKey: "agent:rico-shared:imessage:direct:+15555550111",
    },
    policy: current,
    grantsDirectory: emptyGrants,
  });
  assert.equal(byChatIdMismatch.allow, true, "event.to chat_id must not drop an approved VIP handle from the session");

  const policyThrew = decideIMessageSend({
    event: { to: "+15555550111", content: "Jeff, I am here." },
    policy: undefined,
    policyError: true,
    knownApproved: memory.values(),
    grantsDirectory: emptyGrants,
  });
  assert.equal(policyThrew.allow, true);
  assert.equal(policyThrew.reason, "approved_fail_open");

  const allowFromOnly = decideIMessageSend({
    event: { to: "+15555550111", content: "Jeff, I am here." },
    policy: undefined,
    policyError: true,
    allowFrom: ["+15555550111"],
    grantsDirectory: emptyGrants,
  });
  assert.equal(allowFromOnly.allow, true);

  const strangerAfterThrow = decideIMessageSend({
    event: { to: "+15555550999", content: "nope" },
    policy: undefined,
    policyError: true,
    knownApproved: memory.values(),
  });
  assert.equal(strangerAfterThrow.allow, false);

  const unreadable = fs.mkdtempSync(path.join(os.tmpdir(), "rico-policy-throw-"));
  fs.chmodSync(unreadable, 0o700);
  const policyPath = path.join(unreadable, "rico-recipient-guard.json");
  fs.writeFileSync(policyPath, JSON.stringify(current), { mode: 0o644 });
  assert.throws(() => readPolicy(policyPath, unreadable));

  fs.rmSync(emptyGrants, { recursive: true, force: true });
  fs.rmSync(unreadable, { recursive: true, force: true });
});

test("QA 3: model-fallback and timeout lines are stripped or cancelled before iMessage deliver", () => {
  assert.equal(isInternalModelRoutingNotice(FALLBACK_NO_ARROW), true);
  assert.equal(isInternalModelRoutingNotice(FALLBACK_ARROW), true);
  assert.equal(isInternalModelRoutingNotice(`${FALLBACK_NO_ARROW}\n${PUBLIC_SAFE_SHRUG}`), false);

  assert.deepEqual(prepareIMessageOutboundContent(FALLBACK_NO_ARROW), {
    action: "cancel",
    reason: "model_fallback_notice",
  });
  assert.deepEqual(prepareIMessageOutboundContent(FALLBACK_ARROW), {
    action: "cancel",
    reason: "model_fallback_notice",
  });
  assert.equal(stripInternalModelRoutingText(`${FALLBACK_NO_ARROW}\nHere is the real answer.`), "Here is the real answer.");
  assert.deepEqual(prepareIMessageOutboundContent(`${FALLBACK_NO_ARROW}\nHere is the real answer.`), {
    action: "replace",
    content: "Here is the real answer.",
    reason: "stripped_model_fallback",
  });
  assert.deepEqual(prepareIMessageOutboundContent(`${FALLBACK_NO_ARROW}\n${PUBLIC_SAFE_SHRUG}`), {
    action: "cancel",
    reason: "public_safe_shrug",
  });
  assert.equal(isForbiddenPublicSafeShrug(PUBLIC_SAFE_SHRUG), true);

  const cancelled = decideIMessageSend({
    event: { to: "+15555550111", content: FALLBACK_NO_ARROW },
    policy: policy([jeff]),
  });
  assert.equal(cancelled.allow, false);
  assert.equal(cancelled.reason, "model_fallback_notice");
});

test("QA 4: VIP session model is Claude, not Qwen", () => {
  const jeffContext = resolveSenderContext({
    channel: "imessage",
    senderId: "+15555550111",
    isGroup: false,
    content: "are you there",
  }, {}, policy([jeff, owner, group]));
  assert.equal(jeffContext.conversationType, "direct");
  assert.equal(jeffContext.access, "approved");
  assert.equal(resolveVipDirectModel(jeffContext), RICO_VIP_DIRECT_MODEL);
  assert.notEqual(resolveVipDirectModel(jeffContext), RICO_SHARED_LOCAL_MODEL);
  assert.equal(vipSessionModelIsClaude(jeffContext), true);

  const groupContext = resolveSenderContext({
    channel: "imessage",
    senderId: "+15555550111",
    threadId: 42,
    isGroup: true,
    content: "@rico ping",
  }, {}, policy([jeff, owner, group]));
  assert.equal(groupContext.conversationType, "group");
  assert.equal(resolveVipDirectModel(groupContext), undefined);
});

test("QA 5: a direct DM prompt is not the public-safe/group shrug path", () => {
  const jeffContext = resolveSenderContext({
    channel: "imessage",
    senderId: "+15555550111",
    isGroup: false,
    content: "what is IMT seeing",
  }, {}, policy([jeff, owner, group]));
  const direct = approvedDirectSystemPrompt(jeffContext);
  const groupPrompt = sharedAudienceSystemPrompt({
    ...jeffContext,
    conversationType: "group",
    groupTarget: "chat_id:42",
  });

  assert.match(direct, /private one-to-one conversation/u);
  assert.doesNotMatch(direct, /deliberately isolated public conversation context/u);
  assert.match(direct, /Never say ask Alan directly/u);
  assert.doesNotMatch(direct, /Please ask Alan directly/u);
  assert.doesNotMatch(direct, /shared public-safe group/u);
  assert.match(direct, /stuck-question mailbox/u);
  assert.equal(senderIsolationApplied(direct, jeffContext), true);
  assert.equal(senderIsolationApplied(groupPrompt, jeffContext), false);

  assert.match(groupPrompt, /deliberately isolated public conversation context/u);
  assert.match(groupPrompt, /every group reply is visible to the entire group/u);

  const source = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const promptHook = source.slice(source.indexOf('api.on("before_prompt_build"'), source.indexOf('api.on("before_agent_run"'));
  assert.match(promptHook, /conversationType === "group"/u);
  assert.match(promptHook, /approvedDirectSystemPrompt\(senderContext\)/u);
  assert.match(promptHook, /resolveVipDirectModel\(senderContext/u);
  assert.doesNotMatch(promptHook, /isOwner !== true \|\| senderContext\.conversationType === "group"/u);
});
