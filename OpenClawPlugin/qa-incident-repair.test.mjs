import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  authorizeIMessageAgentRun,
  authorizeOutboundSend,
  colleagueGroupSystemPrompt,
  conversationThreadKeys,
  createApprovedTargetMemory,
  createInboundUptimeLedger,
  directHandleFromSessionKey,
  readGeneralRepliesOpen,
  writeGeneralRepliesOpen,
  isKnownColleagueGroup,
  isPublicSafeDeflection,
  isVipDirectContext,
  prepareIMessageOutboundContent,
  resolveOutboundIdentity,
  resolveSenderContext,
  senderIsolationApplied,
  sharedAudienceSystemPrompt,
  vipDirectSystemPrompt,
} from "./policy.js";
import {
  isVipDirectTurn,
  RICO_VIP_MODEL,
  selectedModelIsLocalQwen,
} from "../RicoVipRoute/route.js";

function policy(identities, paused = false) {
  return { schemaVersion: 2, paused, identities };
}

const jeff = {
  target: "+18148814454",
  kind: "individual",
  access: "approved",
  requireMention: true,
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

const al = {
  target: "+15555550077",
  kind: "individual",
  access: "approved",
  requireMention: true,
  autoReply: true,
  quietStart: 22,
  quietEnd: 8,
  displayName: "Al Sassoon",
  vip: true,
  directChatId: 77,
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
const JEFF_LIVE_SESSION = `agent:rico-shared:imessage:default:direct:${jeff.target}`;
const AL_LIVE_SESSION = `agent:rico-shared:imessage:default:direct:${al.target}`;
const AL_SESSION_ID = "5106dfa8-8629-4316-bf66-f5080c7b1c0b";
const POLAR_OPENED = { generalRepliesOpen: true };
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
  }), { allow: false, reason: "no_inbound_this_uptime" });
  const inboundUptime = createInboundUptimeLedger();
  inboundUptime.rememberHumanInbound({
    senderId: "+15555550999",
    content: "hello",
    messageId: "stranger-1",
  }, { senderId: "+15555550999" });
  assert.deepEqual(authorizeOutboundSend({
    target: "+15555550999",
    event: { to: "+15555550999" },
    policy: current,
    inboundUptime,
  }), { allow: false, reason: "stranger" });
  assert.equal(resolveOutboundIdentity(current, { to: "chat_id:404" }), undefined);
});

test("QA 2: approved VIP is allowed with empty grants and a throwing policy read", () => {
  const current = policy([jeff, owner]);
  const memory = createApprovedTargetMemory();
  memory.rememberPolicy(current);
  const jeffInbound = {
    senderId: jeff.target,
    threadId: 9,
    sessionKey: JEFF_DEFAULT_DIRECT,
    content: "what is IMT seeing",
    messageId: "jeff-live-1",
  };
  const jeffCtx = { chatId: 9, sessionKey: JEFF_DEFAULT_DIRECT };
  memory.rememberInbound(jeffInbound, jeffCtx);
  const inboundUptime = createInboundUptimeLedger();
  assert.equal(inboundUptime.rememberHumanInbound(jeffInbound, jeffCtx), true);

  const emptyGrants = fs.mkdtempSync(path.join(os.tmpdir(), "rico-empty-grants-"));
  fs.chmodSync(emptyGrants, 0o700);

  assert.equal(authorizeOutboundSend({
    target: "chat_id:9",
    event: { to: "chat_id:9", sessionKey: JEFF_DEFAULT_DIRECT },
    ctx: jeffCtx,
    policy: current,
    knownApproved: memory.values(),
    inboundUptime,
  }).reason, "bring_up_owner_only", "VIP inbound is not a send during owner-only bring-up");

  const live = authorizeOutboundSend({
    target: "chat_id:9",
    event: { to: "chat_id:9", sessionKey: JEFF_DEFAULT_DIRECT },
    ctx: jeffCtx,
    policy: current,
    knownApproved: memory.values(),
    inboundUptime,
    bringUp: POLAR_OPENED,
  });
  assert.equal(live.allow, true, "live Jeff DM is chat_id=9 on default:direct after Polar opens");

  const policyThrew = authorizeOutboundSend({
    target: "chat_id:9",
    event: { to: "chat_id:9", sessionKey: JEFF_DEFAULT_DIRECT },
    ctx: jeffCtx,
    policy: undefined,
    policyError: true,
    knownApproved: memory.values(),
    inboundUptime,
    bringUp: POLAR_OPENED,
  });
  assert.equal(policyThrew.allow, true);
  assert.equal(policyThrew.reason, "approved_fail_open");

  const strangerAfterThrow = authorizeOutboundSend({
    target: "+15555550999",
    event: { to: "+15555550999" },
    policy: undefined,
    policyError: true,
    knownApproved: memory.values(),
    inboundUptime,
  });
  assert.equal(strangerAfterThrow.allow, false);

  fs.rmSync(emptyGrants, { recursive: true, force: true });
});

test("QA 3: model-fallback, unavailable, timeout, and guard-block lines never deliver", () => {
  for (const banner of [FALLBACK_TIMEOUT, FALLBACK_UNAVAILABLE, GUARD_BLOCK, EMPTY_QWEN_TURN]) {
    assert.equal(prepareIMessageOutboundContent(banner).action, "cancel", banner);
  }
  assert.equal(prepareIMessageOutboundContent(`${FALLBACK_UNAVAILABLE}\n${PUBLIC_SAFE_ORIBE_SHRUG}`).action, "cancel");
  assert.equal(isPublicSafeDeflection(PUBLIC_SAFE_ORIBE_SHRUG), true);
});

test("QA 4: VIP session model is Claude, not Qwen", () => {
  assert.equal(isVipDirectTurn({
    sessionKey: JEFF_LIVE_SESSION,
    senderId: jeff.target,
    content: "status",
    messageId: "jeff-qa4",
  }, { senderId: jeff.target, channelId: "imessage", messageId: "jeff-qa4" }, [jeff.target]), true);
  assert.equal(isVipDirectTurn({
    sessionKey: JEFF_DEFAULT_DIRECT,
  }, { channelId: "imessage" }, [jeff.target]), false, "default:direct alone is not a VIP send");
  assert.equal(isVipDirectTurn({
    sessionKey: AL_LIVE_SESSION,
  }, { channelId: "imessage" }, [al.target, jeff.target]), false);
  assert.equal(selectedModelIsLocalQwen({ model: "lmstudio/qwen/qwen3.6-35b-a3b" }), true);
  assert.notEqual(RICO_VIP_MODEL, "lmstudio/qwen/qwen3.6-35b-a3b");
  assert.match(RICO_VIP_MODEL, /claude-opus-4-8/u);
});

test("QA 5: a direct DM prompt is not the public-safe/group shrug path", () => {
  const jeffContext = resolveSenderContext({
    channel: "imessage",
    senderId: jeff.target,
    isGroup: false,
    content: "what is IMT seeing",
  }, {}, policy([jeff, owner, colleagueGroup]));
  assert.equal(isVipDirectContext(jeffContext), true);
  const direct = vipDirectSystemPrompt(jeffContext);
  assert.match(direct, /private one-to-one iMessage/u);
  assert.doesNotMatch(direct, /deliberately isolated public conversation context/u);
  assert.match(direct, /Do not tell the current speaker to ask Alan/u);
  assert.equal(senderIsolationApplied(direct, jeffContext), true);
  assert.equal(senderIsolationApplied(sharedAudienceSystemPrompt(jeffContext), jeffContext), false);
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
  assert.deepEqual(prepareIMessageOutboundContent(PUBLIC_SAFE_ORIBE_SHRUG), {
    action: "cancel",
    reason: "public_safe_shrug",
  });
});

test("QA 7: gateway start / session resume / queued assistant cannot deliver with no inbound this uptime", () => {
  const current = policy([jeff, owner, al]);
  const empty = createInboundUptimeLedger();
  const hello = "Hey Al, just checking in.";

  assert.equal(prepareIMessageOutboundContent(hello).action, "deliver");
  assert.deepEqual(conversationThreadKeys({
    sessionKey: JEFF_DEFAULT_DIRECT,
  }, {}), []);

  for (const trigger of ["heartbeat", "cron", "session_resume", "resume", "gateway_start", "catchup"]) {
    assert.deepEqual(authorizeIMessageAgentRun({
      event: { sessionKey: "agent:rico-shared:imessage:direct:+15555550077", trigger },
      ctx: { chatId: 77, trigger },
      inboundUptime: empty,
    }), { allow: false, reason: "unsolicited_trigger" });
    assert.equal(authorizeOutboundSend({
      target: "chat_id:77",
      event: { to: "chat_id:77", sessionKey: "agent:rico-shared:imessage:direct:+15555550077" },
      ctx: { chatId: 77, trigger },
      policy: current,
      inboundUptime: empty,
    }).reason, "unsolicited_trigger");
  }

  assert.deepEqual(authorizeIMessageAgentRun({
    event: { sessionKey: JEFF_DEFAULT_DIRECT, prompt: "queued assistant turn" },
    ctx: { chatId: 9, sessionKey: JEFF_DEFAULT_DIRECT },
    inboundUptime: empty,
  }), { allow: false, reason: "no_inbound_this_uptime" });

  const flushed = authorizeOutboundSend({
    target: "chat_id:9",
    event: { to: "chat_id:9", sessionKey: JEFF_DEFAULT_DIRECT, content: hello },
    ctx: { chatId: 9, sessionKey: JEFF_DEFAULT_DIRECT },
    policy: current,
    inboundUptime: empty,
  });
  assert.equal(flushed.allow, false);
  assert.equal(flushed.reason, "no_inbound_this_uptime");
});

test("QA 8: default:direct or a VIP flag cannot text Al with no inbound on that thread", () => {
  const current = policy([jeff, owner, al]);
  const inboundUptime = createInboundUptimeLedger();
  inboundUptime.rememberHumanInbound({
    senderId: owner.target,
    threadId: 570,
    sessionKey: JEFF_DEFAULT_DIRECT,
    content: "you up?",
    messageId: "alan-dm-1",
  }, { chatId: 570, sessionKey: JEFF_DEFAULT_DIRECT, senderId: owner.target });

  assert.equal(isVipDirectTurn({
    sessionKey: JEFF_DEFAULT_DIRECT,
  }, { channelId: "imessage" }, [al.target, jeff.target]), false);

  const alFlush = authorizeOutboundSend({
    target: "chat_id:77",
    event: { to: "chat_id:77", sessionKey: JEFF_DEFAULT_DIRECT, content: "Hey Al" },
    ctx: { chatId: 77, sessionKey: JEFF_DEFAULT_DIRECT },
    policy: current,
    inboundUptime,
  });
  assert.equal(alFlush.allow, false, "Al cannot be texted because he did not write");
  assert.equal(alFlush.reason, "no_inbound_this_uptime");

  const alNamed = authorizeOutboundSend({
    target: al.target,
    event: { to: al.target, sessionKey: "agent:rico-shared:imessage:direct:+15555550077" },
    ctx: { chatId: 77 },
    policy: current,
    inboundUptime,
  });
  assert.equal(alNamed.allow, false);

  const alanReply = authorizeOutboundSend({
    target: "chat_id:570",
    event: { to: "chat_id:570", sessionKey: JEFF_DEFAULT_DIRECT },
    ctx: { chatId: 570, sessionKey: JEFF_DEFAULT_DIRECT, senderId: owner.target },
    policy: current,
    inboundUptime,
  });
  assert.equal(alanReply.allow, true, "Alan owner DM still sends");
});

test("QA 9: Jeff, Al, and Alan still send when THEY write; last-mile banners still cancel", () => {
  const current = policy([jeff, owner, al]);
  const inboundUptime = createInboundUptimeLedger();
  inboundUptime.rememberHumanInbound({
    senderId: jeff.target,
    threadId: 9,
    sessionKey: JEFF_DEFAULT_DIRECT,
    content: "status",
    messageId: "jeff-2",
  }, { chatId: 9, sessionKey: JEFF_DEFAULT_DIRECT, senderId: jeff.target });
  inboundUptime.rememberHumanInbound({
    senderId: al.target,
    threadId: 77,
    content: "hey rico",
    messageId: "al-1",
  }, { chatId: 77, senderId: al.target });
  inboundUptime.rememberHumanInbound({
    senderId: owner.target,
    threadId: 570,
    content: "ping",
    messageId: "alan-2",
  }, { chatId: 570, senderId: owner.target });

  assert.equal(authorizeOutboundSend({
    target: "chat_id:9",
    event: { to: "chat_id:9", sessionKey: JEFF_DEFAULT_DIRECT },
    ctx: { chatId: 9, sessionKey: JEFF_DEFAULT_DIRECT },
    policy: current,
    inboundUptime,
  }).reason, "bring_up_owner_only");
  assert.equal(authorizeOutboundSend({
    target: "chat_id:9",
    event: { to: "chat_id:9", sessionKey: JEFF_DEFAULT_DIRECT },
    ctx: { chatId: 9, sessionKey: JEFF_DEFAULT_DIRECT },
    policy: current,
    inboundUptime,
    bringUp: POLAR_OPENED,
  }).allow, true);
  assert.equal(authorizeOutboundSend({
    target: "chat_id:77",
    event: { to: "chat_id:77" },
    ctx: { chatId: 77 },
    policy: current,
    inboundUptime,
    bringUp: POLAR_OPENED,
  }).allow, true);
  assert.equal(authorizeOutboundSend({
    target: "chat_id:570",
    event: { to: "chat_id:570" },
    ctx: { chatId: 570 },
    policy: current,
    inboundUptime,
  }).allow, true, "Alan owner DM sends during owner-only bring-up");

  for (const banner of [FALLBACK_TIMEOUT, FALLBACK_UNAVAILABLE, GUARD_BLOCK, EMPTY_QWEN_TURN, PUBLIC_SAFE_ORIBE_SHRUG]) {
    assert.equal(prepareIMessageOutboundContent(banner).action, "cancel", banner);
  }
});

test("QA 10: stale replayed inbound from before this uptime does not authorize a send", () => {
  const startedAt = Date.now();
  const inboundUptime = createInboundUptimeLedger({ startedAt });
  assert.equal(inboundUptime.rememberHumanInbound({
    senderId: al.target,
    threadId: 77,
    content: "old hello",
    messageId: "stale-al",
    timestamp: startedAt - 60_000,
  }, { chatId: 77 }), false);
  assert.equal(authorizeOutboundSend({
    target: "chat_id:77",
    event: { to: "chat_id:77" },
    ctx: { chatId: 77 },
    policy: policy([al]),
    inboundUptime,
  }).allow, false);
});

test("QA 11: newest live default:direct:<handle> that is not last4 4454 cannot send without inbound", () => {
  assert.match(JEFF_LIVE_SESSION, /4454$/u);
  assert.doesNotMatch(AL_LIVE_SESSION, /4454$/u);
  assert.equal(directHandleFromSessionKey(AL_LIVE_SESSION), al.target);
  assert.equal(directHandleFromSessionKey(JEFF_DEFAULT_DIRECT), "");

  const current = policy([jeff, owner, al]);
  const inboundUptime = createInboundUptimeLedger();
  assert.equal(inboundUptime.rememberHumanInbound({
    senderId: jeff.target,
    threadId: 9,
    sessionKey: JEFF_LIVE_SESSION,
    content: "morning VIP inbox only",
    messageId: "jeff-morning-z",
    timestamp: Date.now() - 8 * 60 * 60 * 1000,
  }, { chatId: 9, sessionKey: JEFF_LIVE_SESSION }), false, "morning Jeff events are not this uptime");

  assert.equal(isVipDirectTurn({ sessionKey: AL_LIVE_SESSION }, { channelId: "imessage" }, [al.target, jeff.target]), false);
  assert.equal(isVipDirectTurn({
    sessionKey: AL_LIVE_SESSION,
    senderId: al.target,
  }, { senderId: al.target, channelId: "imessage" }, [al.target]), false);
  assert.equal(isVipDirectTurn({
    sessionKey: AL_LIVE_SESSION,
    senderId: al.target,
    trigger: "session_resume",
    content: "queued assistant",
    messageId: "resume-1",
  }, { senderId: al.target, trigger: "session_resume" }, [al.target]), false);

  const newest = { sessionKey: AL_LIVE_SESSION, to: al.target, content: "Hey" };
  assert.deepEqual(conversationThreadKeys(newest, { sessionKey: AL_LIVE_SESSION }), [`direct:${al.target}`]);
  assert.equal(authorizeIMessageAgentRun({
    event: newest,
    ctx: { sessionKey: AL_LIVE_SESSION },
    inboundUptime,
  }).reason, "no_inbound_this_uptime");
  assert.equal(authorizeIMessageAgentRun({
    event: newest,
    ctx: { sessionKey: AL_LIVE_SESSION, trigger: "session_resume" },
    inboundUptime,
  }).reason, "unsolicited_trigger");
  assert.equal(authorizeOutboundSend({
    target: al.target,
    event: newest,
    ctx: { sessionKey: AL_LIVE_SESSION },
    policy: current,
    inboundUptime,
  }).allow, false);
  assert.equal(authorizeOutboundSend({
    target: al.target,
    event: { sessionKey: AL_LIVE_SESSION, content: "queued assistant" },
    ctx: { sessionKey: AL_LIVE_SESSION, trigger: "gateway_start" },
    policy: current,
    inboundUptime,
  }).reason, "unsolicited_trigger");

  inboundUptime.rememberHumanInbound({
    senderId: jeff.target,
    threadId: 9,
    sessionKey: JEFF_LIVE_SESSION,
    content: "status",
    messageId: "jeff-now",
  }, { chatId: 9, sessionKey: JEFF_LIVE_SESSION, senderId: jeff.target });
  assert.equal(authorizeOutboundSend({
    target: "chat_id:9",
    event: { to: "chat_id:9", sessionKey: JEFF_LIVE_SESSION },
    ctx: { chatId: 9, sessionKey: JEFF_LIVE_SESSION },
    policy: current,
    inboundUptime,
  }).reason, "bring_up_owner_only");
  assert.equal(authorizeOutboundSend({
    target: "chat_id:9",
    event: { to: "chat_id:9", sessionKey: JEFF_LIVE_SESSION },
    ctx: { chatId: 9, sessionKey: JEFF_LIVE_SESSION },
    policy: current,
    inboundUptime,
    bringUp: POLAR_OPENED,
  }).allow, true);
  assert.equal(authorizeOutboundSend({
    target: al.target,
    event: newest,
    ctx: { sessionKey: AL_LIVE_SESSION },
    policy: current,
    inboundUptime,
  }).allow, false, "Jeff inbound does not authorize the other default:direct session");
});

test("QA 12: bring-up is owner-only; VIP inbound this uptime still does not send until Polar opens", () => {
  const current = policy([jeff, owner, al]);
  const startedAt = Date.now();
  const inboundUptime = createInboundUptimeLedger({ startedAt });
  const alInbound = {
    senderId: al.target,
    threadId: 77,
    sessionKey: AL_LIVE_SESSION,
    sessionId: AL_SESSION_ID,
    content: "On the 1pm flight.",
    messageId: "e7e97490-inbound",
  };
  assert.equal(inboundUptime.rememberHumanInbound(alInbound, {
    chatId: 77,
    sessionKey: AL_LIVE_SESSION,
    sessionId: AL_SESSION_ID,
    senderId: al.target,
  }), true);

  const alSend = {
    target: "chat_id:77",
    event: {
      to: "chat_id:77",
      sessionKey: AL_LIVE_SESSION,
      sessionId: AL_SESSION_ID,
      content: "Safe travels. I'll keep things running.",
    },
    ctx: { chatId: 77, sessionKey: AL_LIVE_SESSION, sessionId: AL_SESSION_ID },
    policy: current,
    inboundUptime,
  };
  assert.equal(authorizeOutboundSend(alSend).reason, "bring_up_owner_only");
  assert.equal(authorizeIMessageAgentRun({
    event: alSend.event,
    ctx: alSend.ctx,
    inboundUptime,
  }).reason, "bring_up_owner_only");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rico-bring-up-"));
  fs.chmodSync(root, 0o700);
  writeGeneralRepliesOpen({ supportDirectory: root, openedAt: startedAt - 1 });
  assert.equal(readGeneralRepliesOpen({ supportDirectory: root, startedAt }).open, false,
    "an open file from before this LaunchAgent start stays owner-only");
  assert.equal(authorizeOutboundSend({
    ...alSend,
    bringUp: { supportDirectory: root, startedAt },
  }).reason, "bring_up_owner_only");

  writeGeneralRepliesOpen({ supportDirectory: root, openedAt: startedAt + 1 });
  assert.equal(readGeneralRepliesOpen({ supportDirectory: root, startedAt }).open, true);
  assert.equal(authorizeOutboundSend({
    ...alSend,
    bringUp: { supportDirectory: root, startedAt },
  }).allow, true, "after Polar opens this uptime, approved inbound may send");

  inboundUptime.rememberHumanInbound({
    senderId: owner.target,
    threadId: 570,
    content: "you up?",
    messageId: "alan-bring-up",
  }, { chatId: 570, senderId: owner.target });
  assert.equal(authorizeOutboundSend({
    target: "chat_id:570",
    event: { to: "chat_id:570" },
    ctx: { chatId: 570 },
    policy: current,
    inboundUptime,
    bringUp: { supportDirectory: root, startedAt: startedAt + 10 },
  }).allow, true, "Alan owner DM sends while general replies stay closed");

  fs.rmSync(root, { recursive: true, force: true });
});
