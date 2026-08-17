import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createSharedEscalationProofRegistry,
  currentPolicyAllowsSharedEscalation,
  escalationCapabilityForContext,
  escalationCapabilityPromptSection,
  escalationPluginConfigured,
  escalationOriginAuthorityHealthy,
  escalationToolConfiguredForContext,
  isSharedEscalationAudience,
  RICO_ESCALATION_ORIGIN_CONTRACT,
  RICO_ESCALATION_ORIGIN_SYMBOL_KEY,
  RICO_ESCALATION_PLUGIN_ID,
  RICO_ESCALATION_TOOL_NAME,
  RICO_SHARED_AGENT_ID,
  RICO_SHARED_WORKSPACE,
} from "./escalation-guard.js";
import { approvedDirectSystemPrompt, sharedAudienceSystemPrompt } from "./policy.js";

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

const pluginConfig = {
  plugins: {
    allow: [RICO_ESCALATION_PLUGIN_ID],
    entries: { [RICO_ESCALATION_PLUGIN_ID]: { enabled: true } },
  },
  agents: {
    list: [{
      id: RICO_SHARED_AGENT_ID,
      workspace: RICO_SHARED_WORKSPACE,
      tools: {
        allow: ["rico_group_email_execute", RICO_ESCALATION_TOOL_NAME],
        elevated: { enabled: false },
        toolsBySender: {
          "*": { allow: [RICO_ESCALATION_TOOL_NAME] },
          "channel:imessage:+15550000001": { allow: ["rico_group_email_execute", RICO_ESCALATION_TOOL_NAME] },
        },
      },
    }],
  },
};

const approvedDirect = {
  conversationType: "direct",
  displayName: "Janet Cummings",
  senderHandle: "+15550000002",
  isOwner: false,
  access: "approved",
  audienceFingerprint: sha256("direct:+15550000002"),
};

const approvedGroup = {
  conversationType: "group",
  displayName: "Janet Cummings",
  senderHandle: "+15550000002",
  isOwner: false,
  access: "approved_group_participant",
  groupTarget: "chat_id:42",
  audienceFingerprint: sha256("group:chat_id:42:+15550000002,person@example.com"),
};

function withCapability(context) {
  return { ...context, escalationCapability: escalationCapabilityForContext(context, pluginConfig) };
}

test("escalation capability is conditional on the exact plugin and a shared Rico audience", () => {
  assert.equal(escalationPluginConfigured(pluginConfig), true);
  assert.equal(escalationPluginConfigured({
    plugins: {
      allow: [RICO_ESCALATION_PLUGIN_ID, RICO_ESCALATION_PLUGIN_ID],
      entries: { [RICO_ESCALATION_PLUGIN_ID]: { enabled: true } },
    },
  }), false);
  assert.equal(escalationPluginConfigured({
    plugins: { allow: [RICO_ESCALATION_PLUGIN_ID], entries: { [RICO_ESCALATION_PLUGIN_ID]: { enabled: false } } },
  }), false);
  assert.equal(escalationPluginConfigured({
    plugins: { allow: [RICO_ESCALATION_PLUGIN_ID], entries: { [RICO_ESCALATION_PLUGIN_ID]: { enabled: true } } },
  }), true);
  assert.equal(escalationOriginAuthorityHealthy(), true);

  assert.equal(isSharedEscalationAudience(approvedDirect), true);
  assert.equal(isSharedEscalationAudience(approvedGroup), true);
  const ownerGroup = { ...approvedGroup, isOwner: true, access: "owner", senderHandle: "+15550000001" };
  assert.equal(isSharedEscalationAudience(ownerGroup), true);
  assert.equal(escalationToolConfiguredForContext(ownerGroup, pluginConfig), true);
  assert.deepEqual(escalationCapabilityForContext(ownerGroup, pluginConfig), {
    available: true,
    toolName: RICO_ESCALATION_TOOL_NAME,
  });
  assert.equal(isSharedEscalationAudience({ ...approvedDirect, isOwner: true, access: "owner" }), false);
  assert.equal(isSharedEscalationAudience({ ...approvedDirect, conversationType: "webchat" }), false);
  assert.equal(isSharedEscalationAudience({ ...approvedGroup, groupTarget: undefined }), false);
  assert.equal(escalationCapabilityForContext(approvedDirect, {}), undefined);
  assert.equal(escalationToolConfiguredForContext(approvedDirect, pluginConfig), true);
  assert.equal(escalationToolConfiguredForContext(approvedDirect, {
    ...pluginConfig,
    agents: { list: [{ ...pluginConfig.agents.list[0], tools: { ...pluginConfig.agents.list[0].tools, allow: [RICO_ESCALATION_TOOL_NAME, "exec"] } }] },
  }), false);
  assert.equal(escalationToolConfiguredForContext(approvedDirect, {
    ...pluginConfig,
    agents: { list: [{
      ...pluginConfig.agents.list[0],
      tools: { ...pluginConfig.agents.list[0].tools, toolsBySender: { "*": { deny: ["*"] } } },
    }] },
  }), false);
  assert.deepEqual(escalationCapabilityForContext(approvedDirect, pluginConfig), {
    available: true,
    toolName: RICO_ESCALATION_TOOL_NAME,
  });
});

test("shared prompt gives the fixed stuck-question handoff without granting generic tools", () => {
  const context = withCapability(approvedDirect);
  const section = escalationCapabilityPromptSection(context);
  assert.match(section, /required facts are missing, unverified, or blocked; never fabricate/u);
  assert.match(section, /Do not end with ‘I don’t know’.*submit the question instead/u);
  assert.match(section, /host—not you—captures the exact visible current question/u);
  assert.match(section, /1-6 concise items in alreadyTried/u);
  assert.match(section, /bounded doneLooksLike/u);
  assert.match(section, /Submit normally waits for the matching result/u);
  assert.match(section, /If and only if submit returns pending, poll only the exact requestId it returned/u);
  assert.match(section, /Rico remains the speaker/u);
  assert.match(section, /Never reveal or mention the request ID, research bench, internal handoff, files, paths/u);

  const prompt = approvedDirectSystemPrompt(context);
  assert.match(prompt, new RegExp(RICO_ESCALATION_TOOL_NAME, "u"));
  assert.match(prompt, /private one-to-one conversation/u);
  assert.doesNotMatch(prompt, /deliberately isolated public conversation context/u);
  const groupPrompt = sharedAudienceSystemPrompt({ ...context, conversationType: "group", groupTarget: "chat_id:42" });
  assert.match(groupPrompt, new RegExp(RICO_ESCALATION_TOOL_NAME, "u"));
  assert.match(groupPrompt, /No other tools or external actions are available/u);
  assert.doesNotMatch(prompt, /rico_group_email_execute/u);
  assert.doesNotMatch(prompt, /\b(?:exec|apply_patch|read_file|write_file|web_search|browser)\b/u);

  const absent = sharedAudienceSystemPrompt(approvedDirect);
  assert.doesNotMatch(absent, new RegExp(RICO_ESCALATION_TOOL_NAME, "u"));
  assert.match(absent, /No tools are available/u);

  const emailAndEscalation = sharedAudienceSystemPrompt({
    ...withCapability({ ...approvedGroup, isOwner: true, access: "owner", senderHandle: "+15550000001" }),
    groupEmailCapability: {
      available: true,
      profiles: [{ profileId: "person:janet", displayName: "Janet Cummings", attachmentsAllowed: false }],
    },
  });
  assert.match(emailAndEscalation, /rico_group_email_execute/u);
  assert.match(emailAndEscalation, new RegExp(RICO_ESCALATION_TOOL_NAME, "u"));
  assert.match(emailAndEscalation, /No other tools or external actions are available/u);
});

test("current policy must still admit the exact direct or group audience", () => {
  const directPolicy = {
    schemaVersion: 2,
    paused: false,
    identities: [{
      target: "+15550000002", kind: "individual", access: "approved",
      requireMention: true, autoReply: true, quietStart: 0, quietEnd: 0,
    }],
  };
  assert.equal(currentPolicyAllowsSharedEscalation(directPolicy, approvedDirect), true);
  assert.equal(currentPolicyAllowsSharedEscalation({ ...directPolicy, paused: true }, approvedDirect), false);
  assert.equal(currentPolicyAllowsSharedEscalation({
    ...directPolicy,
    identities: [{ ...directPolicy.identities[0], autoReply: false }],
  }, approvedDirect), false);
  assert.equal(currentPolicyAllowsSharedEscalation(directPolicy, { ...approvedDirect, isOwner: true, access: "owner" }), false);

  const groupPolicy = {
    schemaVersion: 2,
    paused: false,
    identities: [{
      target: "chat_id:42", kind: "group", access: "approved",
      requireMention: true, autoReply: true, quietStart: 0, quietEnd: 0,
      participants: ["person@example.com", "+15550000002"],
    }],
  };
  assert.equal(currentPolicyAllowsSharedEscalation(groupPolicy, approvedGroup), true);
  assert.equal(currentPolicyAllowsSharedEscalation({
    ...groupPolicy,
    identities: [{ ...groupPolicy.identities[0], participants: ["person@example.com", "+15550000003"] }],
  }, approvedGroup), false);
  assert.equal(currentPolicyAllowsSharedEscalation(groupPolicy, { ...approvedGroup, audienceFingerprint: "a".repeat(64) }), false);
});

test("tool gate requires a run-bound, prompt-and-session-approved shared Rico proof", () => {
  let clock = 1_000;
  const registry = createSharedEscalationProofRegistry({ ttlMs: 100, now: () => clock });
  const context = withCapability(approvedDirect);
  const visibleQuestion = "@rico what is IMT seeing right now\r\nPlease verify.";
  const runEvent = { runId: "run-1", prompt: visibleQuestion };
  const runContext = {
    runId: "run-1",
    agentId: RICO_SHARED_AGENT_ID,
    workspaceDir: RICO_SHARED_WORKSPACE,
    sessionKey: "agent:rico-shared:imessage:direct:opaque",
    sessionId: "session-1",
  };
  assert.equal(registry.attest(runEvent, runContext, context), true);
  assert.equal(registry.attest(runEvent, runContext, context), false);

  const toolEvent = { toolName: RICO_ESCALATION_TOOL_NAME, runId: "run-1", toolCallId: "call-1" };
  const toolContext = {
    agentId: RICO_SHARED_AGENT_ID,
    sessionKey: runContext.sessionKey,
    sessionId: runContext.sessionId,
    runId: "run-1",
    toolName: RICO_ESCALATION_TOOL_NAME,
    toolCallId: "call-1",
  };
  assert.equal(registry.allows(toolEvent, toolContext, context), true);
  assert.equal(registry.allows({ ...toolEvent, runId: "run-other" }, toolContext, context), false);
  assert.equal(registry.allows({ ...toolEvent, toolName: "exec" }, { ...toolContext, toolName: "exec" }, context), false);
  assert.equal(registry.allows(toolEvent, { ...toolContext, agentId: "main" }, context), false);
  assert.equal(registry.allows(toolEvent, { ...toolContext, sessionId: "session-2" }, context), false);
  assert.equal(registry.allows(toolEvent, { ...toolContext, toolCallId: "call-2" }, context), false);
  assert.equal(registry.allows(toolEvent, toolContext, { ...context, audienceFingerprint: "b".repeat(64) }), false);
  assert.equal(registry.allows(toolEvent, toolContext, { ...context, escalationCapability: undefined }), false);
  assert.equal(registry.mintOrigin(toolEvent, toolContext, context), true);
  const authority = globalThis[Symbol.for(RICO_ESCALATION_ORIGIN_SYMBOL_KEY)];
  const originRequest = {
    toolName: RICO_ESCALATION_TOOL_NAME,
    toolCallId: "call-1",
  };
  assert.equal(authority.consume({ ...originRequest, extra: true }), undefined);
  const origin = authority.consume(originRequest);
  assert.equal(origin.contract, RICO_ESCALATION_ORIGIN_CONTRACT);
  assert.equal(origin.agentId, RICO_SHARED_AGENT_ID);
  assert.equal(origin.workspaceDir, RICO_SHARED_WORKSPACE);
  assert.equal(origin.sessionKey, runContext.sessionKey);
  assert.equal(origin.sessionId, runContext.sessionId);
  assert.equal(origin.requesterSenderId, approvedDirect.senderHandle);
  assert.equal(origin.runId, "run-1");
  assert.equal(origin.question, visibleQuestion);
  assert.equal(origin.questionSHA256, sha256(visibleQuestion));
  assert.equal(origin.audience, "approved_direct");
  assert.equal(origin.audienceFingerprint, approvedDirect.audienceFingerprint);
  assert.equal(origin.senderIsOwner, false);
  assert.equal(authority.consume(originRequest), undefined);

  const unproved = createSharedEscalationProofRegistry();
  assert.equal(unproved.allows(toolEvent, toolContext, context), false);
  assert.equal(registry.forget({ runId: "run-1" }), true);
  assert.equal(registry.allows(toolEvent, toolContext, context), false);

  assert.equal(registry.attest({ runId: "run-2", prompt: "@rico another question" }, { ...runContext, runId: "run-2" }, context), true);
  const secondToolEvent = { ...toolEvent, runId: "run-2", toolCallId: "call-2" };
  const secondToolContext = { ...toolContext, runId: "run-2", toolCallId: "call-2" };
  assert.equal(registry.mintOrigin(secondToolEvent, secondToolContext, context), true);
  assert.equal(authority.consume({ ...originRequest, toolCallId: "call-2", senderIsOwner: true }), undefined);
  assert.equal(authority.consume({ ...originRequest, toolCallId: "call-2" })?.runId, "run-2");
  assert.equal(authority.consume({ ...originRequest, toolCallId: "call-2" }), undefined);
  assert.equal(registry.attest(
    { runId: "run-system-prefix", prompt: "System: [synthetic] private context" },
    { ...runContext, runId: "run-system-prefix" },
    context,
  ), false);
  clock = 1_101;
  assert.equal(registry.size, 0);
});

test("guard integration attests only after shared prompt and session checks and keeps default deny", () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(root, "index.js"), "utf8");
  const hook = source.slice(source.indexOf('api.on("before_agent_run"'), source.indexOf('api.on("before_tool_call"'));
  assert.match(hook, /approvedDirect/u);
  assert.ok(hook.indexOf("senderContexts.promptUnchanged") < hook.indexOf("sessionAttestations.verifyOrAttest"));
  assert.ok(hook.indexOf("sessionAttestations.verifyOrAttest") < hook.indexOf('category: "escalation_context_required"'));
  assert.match(hook, /category: "escalation_context_required"/u);

  const toolHook = source.slice(source.indexOf('api.on("before_tool_call"'), source.indexOf('api.on("agent_end"'));
  assert.match(toolHook, /event\.toolName === RICO_ESCALATION_TOOL_NAME/u);
  assert.ok(toolHook.indexOf("event.toolName === RICO_ESCALATION_TOOL_NAME") <
    toolHook.indexOf('senderContext.isOwner === true && senderContext.conversationType === "direct"'));
  assert.match(toolHook, /currentPolicyAllowsSharedEscalation/u);
  assert.match(toolHook, /verifyGroupMembership/u);
  assert.ok(toolHook.indexOf("currentPolicyAllowsSharedEscalation") < toolHook.indexOf("sharedEscalationProofs.mintOrigin"));
  assert.ok(toolHook.indexOf("verifyGroupMembership") < toolHook.indexOf("sharedEscalationProofs.mintOrigin"));
  assert.match(toolHook, /Tools are unavailable in an approved contact conversation/u);
  assert.doesNotMatch(source, /registerTool[\s\S]{0,300}RICO_ESCALATION_TOOL_NAME/u);
});
