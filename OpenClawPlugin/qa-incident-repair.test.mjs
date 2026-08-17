import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  approvedDirectSystemPrompt,
  authorizeOutboundSend,
  colleagueGroupSystemPrompt,
  createApprovedTargetMemory,
  decideIMessageSend,
  isKnownColleagueGroup,
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
  target: "+15555554454",
  kind: "individual",
  access: "approved",
  requireMention: false,
  autoReply: true,
  quietStart: 22,
  quietEnd: 8,
  displayName: "Jeff Roach",
  directChatId: 9,
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

const janet = {
  target: "+15555550024",
  kind: "individual",
  access: "approved",
  requireMention: false,
  autoReply: true,
  quietStart: 0,
  quietEnd: 0,
  displayName: "Janet Cummings",
};

const ana = {
  target: "+15555550025",
  kind: "individual",
  access: "approved",
  requireMention: false,
  autoReply: true,
  quietStart: 0,
  quietEnd: 0,
  displayName: "Ana Tramont",
};

const colleagueGroup = {
  target: "chat_id:24",
  kind: "group",
  access: "approved",
  requireMention: true,
  autoReply: true,
  quietStart: 0,
  quietEnd: 0,
  participants: [owner.target, janet.target, ana.target],
};

const JEFF_DEFAULT_DIRECT = "agent:rico-shared:imessage:default:direct";
const FALLBACK_TIMEOUT =
  "Model Fallback: anthropic/claude-opus-4-8 (selected lmstudio/qwen/qwen3.6-35b-a3b; timeout)";
const FALLBACK_UNAVAILABLE =
  "Model Fallback: anthropic/claude-opus-4-8 (selected lmstudio/qwen/qwen3.6-35b-a3b; selected model unavailable)";
const GUARD_BLOCK = "Your message could not be sent: blocked by rico-recipient-guard";
const EMPTY_QWEN_TURN = "[assistant turn failed before producing content]";
const PUBLIC_SAFE_ORIBE_SHRUG =
  "This is a shared, public-safe space. I don't have the ORIBE awards details. Please ask Alan directly.";

test("QA 1: unknown recipient is denied", () => {
  const current = policy([jeff, owner, colleagueGroup]);
  assert.deepEqual(authorizeOutboundSend({
    target: "+15555550999",
    policy: current,
  }), { allow: false, reason: "stranger" });
  assert.equal(decideIMessageSend({
    event: { to: "chat_id:404", content: "hello from Rico" },
    policy: current,
  }).reason, "stranger");
});

test("QA 2: approved VIP is allowed with empty grants and a throwing policy read", () => {
  const current = policy([jeff, owner]);
  const memory = createApprovedTargetMemory();
  memory.rememberPolicy(current);
  memory.rememberInbound({
    senderId: jeff.target,
    threadId: 9,
    sessionKey: JEFF_DEFAULT_DIRECT,
  }, { chatId: 9, sessionKey: JEFF_DEFAULT_DIRECT });

  const emptyGrants = fs.mkdtempSync(path.join(os.tmpdir(), "rico-empty-grants-"));
  fs.chmodSync(emptyGrants, 0o700);

  const liveChatId = decideIMessageSend({
    event: {
      to: "chat_id:9",
      content: "Jeff, I am here.",
      sessionKey: JEFF_DEFAULT_DIRECT,
    },
    ctx: { chatId: 9, sessionKey: JEFF_DEFAULT_DIRECT },
    policy: current,
    knownApproved: memory.values(),
    grantsDirectory: emptyGrants,
  });
  assert.equal(liveChatId.allow, true, "live Jeff DM is chat_id=9 on default:direct, not an E.164 in the session key");

  const durableChatId = decideIMessageSend({
    event: { to: "chat_id:9", content: "Jeff, I am here.", sessionKey: JEFF_DEFAULT_DIRECT },
    policy: current,
    grantsDirectory: emptyGrants,
  });
  assert.equal(durableChatId.allow, true, "Jeff's reviewed directChatId=9 survives a gateway restart without inbound memory");

  const policyThrew = decideIMessageSend({
    event: { to: "chat_id:9", content: "Jeff, I am here.", sessionKey: JEFF_DEFAULT_DIRECT },
    policy: undefined,
    policyError: true,
    knownApproved: memory.values(),
    grantsDirectory: emptyGrants,
  });
  assert.equal(policyThrew.allow, true);
  assert.equal(policyThrew.reason, "approved_fail_open");

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

test("QA 3: model-fallback, unavailable, timeout, and guard-block lines never deliver", () => {
  for (const banner of [FALLBACK_TIMEOUT, FALLBACK_UNAVAILABLE, GUARD_BLOCK, EMPTY_QWEN_TURN]) {
    assert.equal(isInternalModelRoutingNotice(banner), true, banner);
    assert.equal(prepareIMessageOutboundContent(banner).action, "cancel", banner);
    assert.equal(decideIMessageSend({
      event: { to: "chat_id:9", content: banner, sessionKey: JEFF_DEFAULT_DIRECT },
      policy: policy([jeff]),
    }).allow, false);
  }
  assert.equal(stripInternalModelRoutingText(`${FALLBACK_TIMEOUT}\nHere is the real answer.`), "Here is the real answer.");
  assert.deepEqual(prepareIMessageOutboundContent(`${FALLBACK_UNAVAILABLE}\n${PUBLIC_SAFE_ORIBE_SHRUG}`), {
    action: "cancel",
    reason: "public_safe_shrug",
  });
  assert.equal(isForbiddenPublicSafeShrug(PUBLIC_SAFE_ORIBE_SHRUG), true);
});

test("QA 4: VIP session model is Claude, not Qwen", () => {
  const jeffContext = resolveSenderContext({
    channel: "imessage",
    senderId: jeff.target,
    isGroup: false,
    content: "are you there",
  }, {}, policy([jeff, owner, colleagueGroup]));
  assert.equal(resolveVipDirectModel(jeffContext, JEFF_DEFAULT_DIRECT), RICO_VIP_DIRECT_MODEL);
  assert.notEqual(resolveVipDirectModel(jeffContext, JEFF_DEFAULT_DIRECT), RICO_SHARED_LOCAL_MODEL);
  assert.equal(vipSessionModelIsClaude(jeffContext, JEFF_DEFAULT_DIRECT), true);
});

test("QA 5: a direct DM prompt is not the public-safe/group shrug path", () => {
  const jeffContext = resolveSenderContext({
    channel: "imessage",
    senderId: jeff.target,
    isGroup: false,
    content: "what is IMT seeing",
  }, {}, policy([jeff, owner, colleagueGroup]));
  const direct = approvedDirectSystemPrompt(jeffContext);

  assert.match(direct, /private one-to-one conversation/u);
  assert.doesNotMatch(direct, /deliberately isolated public conversation context/u);
  assert.match(direct, /Never say ask Alan directly/u);
  assert.doesNotMatch(direct, /Please ask Alan directly/u);
  assert.equal(senderIsolationApplied(direct, jeffContext), true);
  assert.equal(senderIsolationApplied(sharedAudienceSystemPrompt({
    ...jeffContext,
    conversationType: "group",
    groupTarget: "chat_id:24",
  }), jeffContext), false);

  const source = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const promptHook = source.slice(source.indexOf('api.on("before_prompt_build"'), source.indexOf('api.on("before_agent_run"'));
  assert.match(promptHook, /isKnownColleagueGroup\(senderContext\)/u);
  assert.match(promptHook, /colleagueGroupSystemPrompt\(senderContext\)/u);
  assert.match(promptHook, /approvedDirectSystemPrompt\(senderContext\)/u);
});

test("QA 6: Ana+Janet colleague group does not emit the public-safe ORIBE shrug", () => {
  const current = policy([owner, janet, ana, colleagueGroup]);
  const groupContext = resolveSenderContext({
    channel: "imessage",
    senderId: janet.target,
    threadId: 24,
    isGroup: true,
    content: "@rico training + ORIBE awards",
  }, { sessionKey: "agent:rico-shared:imessage:group:24" }, current);
  assert.equal(groupContext.conversationType, "group");
  assert.equal(groupContext.groupTarget, "chat_id:24");
  assert.equal(isKnownColleagueGroup(groupContext), true);

  const prompt = colleagueGroupSystemPrompt(groupContext);
  assert.match(prompt, /known colleague group/u);
  assert.match(prompt, /training and awards work/u);
  assert.doesNotMatch(prompt, /deliberately isolated public conversation context/u);
  assert.doesNotMatch(prompt, /Please ask Alan directly/u);
  assert.doesNotMatch(prompt, /ORIBE/u);
  assert.equal(senderIsolationApplied(prompt, groupContext), true);
  assert.equal(senderIsolationApplied(sharedAudienceSystemPrompt(groupContext), groupContext), false);
  assert.equal(isForbiddenPublicSafeShrug(PUBLIC_SAFE_ORIBE_SHRUG), true);
  assert.deepEqual(prepareIMessageOutboundContent(PUBLIC_SAFE_ORIBE_SHRUG), {
    action: "cancel",
    reason: "public_safe_shrug",
  });
  assert.equal(decideIMessageSend({
    event: { to: "chat_id:24", content: PUBLIC_SAFE_ORIBE_SHRUG },
    policy: current,
  }).reason, "public_safe_shrug");
});
