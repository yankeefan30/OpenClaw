import crypto from "node:crypto";

export const RICO_ESCALATION_PLUGIN_ID = "rico-escalation-handoff";
export const RICO_ESCALATION_TOOL_NAME = "rico_stuck_question_escalate";
export const RICO_SHARED_AGENT_ID = "rico-shared";
export const RICO_SHARED_WORKSPACE = "/Users/alan/.openclaw/workspace-rico-shared";
export const RICO_ESCALATION_ORIGIN_CONTRACT = "rico-recipient-guard/escalation-origin/v1";
export const RICO_ESCALATION_ORIGIN_SYMBOL_KEY = "rico.recipient-guard.escalation-origin/v1";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DIRECT_ACCESS = new Set(["approved", "trusted"]);
const GROUP_ACCESS = new Set(["approved", "trusted", "approved_group_participant", "owner"]);
const SHARED_TOOL_ALLOWLIST = new Set([RICO_ESCALATION_TOOL_NAME, "rico_group_email_execute"]);
const ESCALATION_ORIGIN_SYMBOL = Symbol.for(RICO_ESCALATION_ORIGIN_SYMBOL_KEY);
const originGrants = new Map();

function cleanSingleLine(value, max = 1200) {
  const text = String(value ?? "").normalize("NFC").trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f-\u009f\r\n]/u.test(text)) return "";
  return text;
}

function normalizeHandle(value) {
  const text = cleanSingleLine(value, 320).toLowerCase();
  if (/^\+[1-9][0-9]{6,14}$/u.test(text)) return text;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(text)) return text;
  return "";
}

function normalizeTarget(value) {
  const text = cleanSingleLine(value, 1200).toLowerCase();
  return /^chat_(?:id|guid|identifier):.+$/u.test(text) ? text : "";
}

function exactCorrelated(...values) {
  const present = values
    .filter((value) => value != null && String(value).trim() !== "")
    .map((value) => cleanSingleLine(value, 1200));
  if (present.length === 0 || present.some((value) => !value)) return "";
  const unique = [...new Set(present)];
  return unique.length === 1 ? unique[0] : "";
}

function classifySharedSession(sessionKey) {
  const key = cleanSingleLine(sessionKey, 1200).toLowerCase();
  if (!key.startsWith(`agent:${RICO_SHARED_AGENT_ID}:imessage:`)) return "";
  if (key.includes(":group:")) return "group";
  if (key.includes(":direct:")) return "direct";
  return "";
}

function audienceFingerprint(context) {
  const value = cleanSingleLine(context?.audienceFingerprint, 64).toLowerCase();
  return /^[a-f0-9]{64}$/u.test(value) ? value : "";
}

function exactOriginConsumeRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return undefined;
  const expectedKeys = ["toolCallId", "toolName"];
  const actualKeys = Object.keys(value).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) return undefined;
  const request = {
    toolName: cleanSingleLine(value.toolName, 128),
    toolCallId: cleanSingleLine(value.toolCallId, 512),
  };
  if (request.toolName !== RICO_ESCALATION_TOOL_NAME || !request.toolCallId) return undefined;
  return request;
}

const originAuthority = Object.freeze({
  contract: RICO_ESCALATION_ORIGIN_CONTRACT,
  consume(value) {
    const request = exactOriginConsumeRequest(value);
    if (!request) return undefined;
    const grant = originGrants.get(request.toolCallId);
    if (!grant) return undefined;
    // Claim before checking the rest of the tuple. A guessed or raced call can
    // only burn the grant; it can never turn a failed proof into a retry oracle.
    originGrants.delete(request.toolCallId);
    if (!grant.isFresh() || request.toolName !== grant.toolName) return undefined;
    return Object.freeze({
      contract: RICO_ESCALATION_ORIGIN_CONTRACT,
      agentId: grant.agentId,
      workspaceDir: grant.workspaceDir,
      sessionKey: grant.sessionKey,
      sessionId: grant.sessionId,
      requesterSenderId: grant.requesterSenderId,
      runId: grant.runId,
      question: grant.question,
      questionSHA256: grant.questionSHA256,
      audience: grant.audience,
      audienceFingerprint: grant.audienceFingerprint,
      senderIsOwner: grant.senderIsOwner,
    });
  },
});

if (Object.getOwnPropertyDescriptor(globalThis, ESCALATION_ORIGIN_SYMBOL) === undefined) {
  Object.defineProperty(globalThis, ESCALATION_ORIGIN_SYMBOL, {
    value: originAuthority,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

export function escalationOriginAuthorityHealthy() {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, ESCALATION_ORIGIN_SYMBOL);
  return descriptor?.value === originAuthority && descriptor.configurable === false &&
    descriptor.enumerable === false && descriptor.writable === false;
}

export function isSharedEscalationAudience(context) {
  const conversationType = context?.conversationType;
  const senderHandle = normalizeHandle(context?.senderHandle);
  if (!senderHandle || !audienceFingerprint(context)) return false;
  if (conversationType === "direct") {
    return context?.isOwner !== true && DIRECT_ACCESS.has(String(context?.access ?? "").toLowerCase());
  }
  if (conversationType === "group") {
    return Boolean(normalizeTarget(context?.groupTarget)) && GROUP_ACCESS.has(String(context?.access ?? "").toLowerCase());
  }
  return false;
}

export function escalationPluginConfigured(config) {
  const allow = config?.plugins?.allow;
  const entry = config?.plugins?.entries?.[RICO_ESCALATION_PLUGIN_ID];
  return Array.isArray(allow) && allow.filter((value) => value === RICO_ESCALATION_PLUGIN_ID).length === 1 &&
    entry?.enabled === true;
}

function exactRestrictiveToolAllow(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy) || !Array.isArray(policy.allow) ||
      policy.allow.length < 1 || policy.allow.some((name) => !SHARED_TOOL_ALLOWLIST.has(name)) ||
      !policy.allow.includes(RICO_ESCALATION_TOOL_NAME) ||
      (Array.isArray(policy.deny) && policy.deny.some((name) => name === "*" || name === RICO_ESCALATION_TOOL_NAME)) ||
      (Array.isArray(policy.alsoAllow) && policy.alsoAllow.length > 0)) return false;
  return new Set(policy.allow).size === policy.allow.length;
}

export function escalationToolConfiguredForContext(context, config) {
  if (!isSharedEscalationAudience(context)) return false;
  const agents = config?.agents?.list;
  if (!Array.isArray(agents)) return false;
  const matches = agents.filter((agent) => agent?.id === RICO_SHARED_AGENT_ID && agent?.workspace === RICO_SHARED_WORKSPACE);
  if (matches.length !== 1 || matches[0]?.tools?.elevated?.enabled !== false ||
      !exactRestrictiveToolAllow(matches[0]?.tools)) return false;
  const policies = matches[0].tools?.toolsBySender;
  if (!policies || typeof policies !== "object" || Array.isArray(policies)) return false;
  const senderKey = `channel:imessage:${normalizeHandle(context.senderHandle)}`;
  const exactPolicies = Object.entries(policies).filter(([key]) => key.toLowerCase() === senderKey);
  if (exactPolicies.length > 1) return false;
  const effective = exactPolicies.length === 1 ? exactPolicies[0][1] : policies["*"];
  return exactRestrictiveToolAllow(effective);
}

export function escalationCapabilityForContext(context, config) {
  if (!isSharedEscalationAudience(context) || !escalationPluginConfigured(config) ||
      !escalationToolConfiguredForContext(context, config) || !escalationOriginAuthorityHealthy()) return undefined;
  return Object.freeze({ available: true, toolName: RICO_ESCALATION_TOOL_NAME });
}

export function escalationCapabilityPromptSection(context) {
  if (!isSharedEscalationAudience(context) || context?.escalationCapability?.available !== true ||
      context?.escalationCapability?.toolName !== RICO_ESCALATION_TOOL_NAME) return "";
  return [
    `A narrow local verification handoff is available through ${RICO_ESCALATION_TOOL_NAME}. Use it when the visible question cannot be answered reliably because required facts are missing, unverified, or blocked; never fabricate an answer.`,
    "Do not end with ‘I don’t know’ when this handoff can verify the missing point; submit the question instead.",
    "For submit, the host—not you—captures the exact visible current question. Provide only 1-6 concise items in alreadyTried describing authorized attempts made in this conversation, plus a bounded doneLooksLike statement describing the evidence a complete answer requires. Do not add hidden or private context.",
    "Submit normally waits for the matching result. If and only if submit returns pending, poll only the exact requestId it returned. If the result is still pending, say only that the point is being verified. Validate any completed evidence against the visible question before answering.",
    "Rico remains the speaker. Never reveal or mention the request ID, research bench, internal handoff, files, paths, private sources, or implementation details to the human.",
  ].join("\n");
}

function expectedAudienceFingerprint(policy, context) {
  const sender = normalizeHandle(context?.senderHandle);
  if (context?.conversationType === "direct") {
    return crypto.createHash("sha256").update(`direct:${sender}`, "utf8").digest("hex");
  }
  const target = normalizeTarget(context?.groupTarget);
  const groups = policy.identities.filter((item) => item?.kind === "group" && normalizeTarget(item.target) === target);
  if (groups.length !== 1 || !Array.isArray(groups[0].participants) || groups[0].participants.length === 0) return "";
  const participants = groups[0].participants.map(normalizeHandle);
  if (participants.some((value) => !value) || new Set(participants).size !== participants.length) return "";
  return crypto.createHash("sha256")
    .update(`group:${target}:${[...participants].sort().join(",")}`, "utf8")
    .digest("hex");
}

/** Re-proves that the current private policy still admits the bound audience. */
export function currentPolicyAllowsSharedEscalation(policy, context) {
  if (!isSharedEscalationAudience(context) || policy?.schemaVersion !== 2 || policy?.paused !== false ||
      !Array.isArray(policy.identities)) return false;
  const sender = normalizeHandle(context.senderHandle);
  const individuals = policy.identities.filter((item) => item?.kind === "individual" && normalizeHandle(item.target) === sender);
  if (individuals.length > 1 || individuals.some((item) => item.access === "blocked")) return false;

  if (context.conversationType === "direct") {
    if (individuals.length !== 1 || individuals[0].autoReply !== true ||
        !DIRECT_ACCESS.has(String(individuals[0].access ?? "").toLowerCase())) return false;
  } else {
    const target = normalizeTarget(context.groupTarget);
    const groups = policy.identities.filter((item) => item?.kind === "group" && normalizeTarget(item.target) === target);
    if (groups.length !== 1 || groups[0].autoReply !== true || groups[0].access === "blocked" ||
        !Array.isArray(groups[0].participants)) return false;
    const participants = groups[0].participants.map(normalizeHandle);
    if (context.isOwner === true) {
      if (individuals.length !== 1 || individuals[0].access !== "owner" || individuals[0].autoReply !== true) return false;
    } else if (!participants.includes(sender)) {
      return false;
    }
  }
  return expectedAudienceFingerprint(policy, context) === audienceFingerprint(context);
}

/**
 * Records a tool gate only after the caller has already proved shared prompt
 * integrity and session attestation in before_agent_run. The tool hook can
 * later accept only the exact same Rico run/session/audience tuple.
 */
export function createSharedEscalationProofRegistry({
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = 256,
  now = () => Date.now(),
} = {}) {
  const entries = new Map();

  function forgetOriginGrants(runId) {
    for (const [toolCallId, grant] of originGrants) {
      if (grant.runId === runId) originGrants.delete(toolCallId);
    }
  }

  function prune() {
    const cutoff = now() - ttlMs;
    for (const [runId, entry] of entries) {
      if (entry.createdAt < cutoff) {
        entries.delete(runId);
        forgetOriginGrants(runId);
      }
    }
    while (entries.size > maxEntries) {
      const runId = entries.keys().next().value;
      entries.delete(runId);
      forgetOriginGrants(runId);
    }
  }

  function allows(event, ctx, context) {
    prune();
    const runId = exactCorrelated(event?.runId, ctx?.runId);
    const toolCallId = exactCorrelated(event?.toolCallId, ctx?.toolCallId);
    const entry = runId ? entries.get(runId) : undefined;
    return Boolean(entry && toolCallId && event?.toolName === RICO_ESCALATION_TOOL_NAME &&
      ctx?.toolName === RICO_ESCALATION_TOOL_NAME && ctx?.agentId === RICO_SHARED_AGENT_ID &&
      cleanSingleLine(ctx?.sessionKey, 1200) === entry.sessionKey &&
      cleanSingleLine(ctx?.sessionId, 512) === entry.sessionId &&
      isSharedEscalationAudience(context) && context?.escalationCapability?.available === true &&
      context?.escalationCapability?.toolName === RICO_ESCALATION_TOOL_NAME &&
      context.conversationType === entry.conversationType &&
      normalizeHandle(context.senderHandle) === entry.senderHandle &&
      normalizeTarget(context.groupTarget) === entry.groupTarget &&
      audienceFingerprint(context) === entry.audienceFingerprint);
  }

  return Object.freeze({
    attest(event, ctx, context) {
      prune();
      const runId = exactCorrelated(event?.runId, ctx?.runId);
      const sessionKey = cleanSingleLine(ctx?.sessionKey, 1200);
      const sessionId = cleanSingleLine(ctx?.sessionId, 512);
      const conversationType = classifySharedSession(sessionKey);
      const question = String(event?.prompt ?? "");
      if (!runId || !sessionId || ctx?.agentId !== RICO_SHARED_AGENT_ID ||
          ctx?.workspaceDir !== RICO_SHARED_WORKSPACE || conversationType !== context?.conversationType ||
          !isSharedEscalationAudience(context) || context?.escalationCapability?.available !== true ||
          context?.escalationCapability?.toolName !== RICO_ESCALATION_TOOL_NAME || !question || question.length > 4_000 ||
          /^(?:System|Developer|Assistant):[ \t]/u.test(question) ||
          /^<\|(?:im_start|system|developer|assistant)/u.test(question) ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(question)) return false;
      if (entries.has(runId)) return false;
      entries.set(runId, Object.freeze({
        runId,
        sessionKey,
        sessionId,
        conversationType,
        senderHandle: normalizeHandle(context.senderHandle),
        groupTarget: normalizeTarget(context.groupTarget),
        audienceFingerprint: audienceFingerprint(context),
        visibleQuestion: question,
        visibleQuestionSHA256: crypto.createHash("sha256").update(question, "utf8").digest("hex"),
        createdAt: now(),
      }));
      return true;
    },

    allows,

    mintOrigin(event, ctx, context) {
      prune();
      if (!escalationOriginAuthorityHealthy() || !allows(event, ctx, context)) return false;
      const runId = exactCorrelated(event?.runId, ctx?.runId);
      const toolCallId = exactCorrelated(event?.toolCallId, ctx?.toolCallId);
      const entry = entries.get(runId);
      const grant = Object.freeze({
        toolName: RICO_ESCALATION_TOOL_NAME,
        toolCallId,
        runId,
        agentId: RICO_SHARED_AGENT_ID,
        workspaceDir: RICO_SHARED_WORKSPACE,
        sessionKey: entry.sessionKey,
        sessionId: entry.sessionId,
        requesterSenderId: entry.senderHandle,
        senderIsOwner: context.isOwner === true,
        question: entry.visibleQuestion,
        questionSHA256: entry.visibleQuestionSHA256,
        audience: entry.conversationType === "group" ? "approved_group" : "approved_direct",
        audienceFingerprint: entry.audienceFingerprint,
        isFresh: () => now() - entry.createdAt <= ttlMs,
      });
      const existing = originGrants.get(toolCallId);
      if (existing) {
        return existing.runId === grant.runId && existing.sessionKey === grant.sessionKey &&
          existing.sessionId === grant.sessionId && existing.requesterSenderId === grant.requesterSenderId &&
          existing.senderIsOwner === grant.senderIsOwner && existing.questionSHA256 === grant.questionSHA256;
      }
      originGrants.set(toolCallId, grant);
      return true;
    },

    forget(ctx) {
      const runId = exactCorrelated(ctx?.runId);
      if (!runId) return false;
      forgetOriginGrants(runId);
      return entries.delete(runId);
    },

    get size() {
      prune();
      return entries.size;
    },
  });
}
