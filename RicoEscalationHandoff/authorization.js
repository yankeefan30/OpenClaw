import crypto from "node:crypto";

const TOOL_NAME = "rico_stuck_question_escalate";
const EXPECTED_AGENT_ID = "rico-shared";
const EXPECTED_WORKSPACE = "/Users/alan/.openclaw/workspace-rico-shared";
const ORIGIN_BRIDGE_CONTRACT = "rico-recipient-guard/escalation-origin/v1";
const ORIGIN_BRIDGE_SYMBOL = Symbol.for("rico.recipient-guard.escalation-origin/v1");

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export class SubmittedRequestRegistry {
  #entries = new Map();
  #now;
  #ttlMs;
  #maxEntries;

  constructor({ now = () => performance.now(), ttlMs = 45 * 60 * 1000, maxEntries = 256 } = {}) {
    if (typeof now !== "function" || !Number.isFinite(ttlMs) || ttlMs < 1 ||
        !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 4096) {
      throw coded("submitted_request_registry_config_invalid");
    }
    this.#now = now;
    this.#ttlMs = ttlMs;
    this.#maxEntries = maxEntries;
  }

  get(runId) {
    const key = boundedRegistryValue(runId, "run_id");
    this.#prune();
    return this.#entries.get(key)?.requestId ?? "";
  }

  set(runId, requestId) {
    const key = boundedRegistryValue(runId, "run_id");
    const value = boundedRegistryValue(requestId, "request_id");
    const now = this.#time();
    this.#prune(now);
    this.#entries.delete(key);
    while (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest == null) break;
      this.#entries.delete(oldest);
    }
    this.#entries.set(key, Object.freeze({ requestId: value, expiresAt: now + this.#ttlMs }));
  }

  get size() {
    this.#prune();
    return this.#entries.size;
  }

  #time() {
    const value = this.#now();
    if (!Number.isFinite(value) || value < 0) throw coded("submitted_request_registry_clock_invalid");
    return value;
  }

  #prune(now = this.#time()) {
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
  }
}

function boundedRegistryValue(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw coded(`submitted_request_${label}_invalid`);
  }
  return value;
}

function cleanSingleLine(value, max = 1024) {
  const text = String(value ?? "").normalize("NFC").trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f-\u009f\r\n]/u.test(text)) return "";
  return text;
}

function cleanPrompt(value, max = 4000) {
  const text = String(value ?? "").normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  if (!text || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) return "";
  return text;
}

function normalizeHandle(value) {
  const text = cleanSingleLine(value, 320).toLowerCase();
  if (/^\+[1-9][0-9]{6,14}$/u.test(text)) return text;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(text)) return text;
  return "";
}

function exactDigest(value) {
  const digest = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/u.test(digest) ? digest : "";
}

function messageHash(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function classifySession(sessionKey) {
  const value = cleanSingleLine(sessionKey, 1200).toLowerCase();
  if (!value.startsWith(`agent:${EXPECTED_AGENT_ID}:imessage:`)) return "";
  const isGroup = value.includes(":group:");
  const isDirect = value.includes(":direct:");
  if (isGroup === isDirect) return "";
  if (isGroup) return "approved_group";
  if (isDirect) return "approved_direct";
  return "";
}

function audienceScope(sessionKey, sessionId, senderId) {
  return crypto.createHash("sha256").update([sessionKey, sessionId, senderId].join("\u0000"), "utf8").digest("hex");
}

/**
 * Consume one guard-minted raw-inbound-body proof. The public process-local
 * bridge exposes no mint method: only the recipient guard retains that closure.
 * Tool discovery is deliberately context-independent. Authority comes only
 * from this single-use tool-call capability, which carries the guard-verified
 * agent, session, sender, audience, and raw visible question.
 */
export function consumeVerifiedEscalationOrigin(toolCallId) {
  const exactToolCallId = cleanSingleLine(toolCallId, 512);
  if (!exactToolCallId) throw coded("escalation_origin_request_invalid");
  const bridge = globalThis[ORIGIN_BRIDGE_SYMBOL];
  if (!bridge || !Object.isFrozen(bridge) || bridge.contract !== ORIGIN_BRIDGE_CONTRACT ||
      typeof bridge.consume !== "function") {
    throw coded("escalation_origin_bridge_unavailable");
  }
  const proof = bridge.consume(Object.freeze({
    toolName: TOOL_NAME,
    toolCallId: exactToolCallId,
  }));
  const expectedProofKeys = [
    "agentId", "audience", "audienceFingerprint", "contract", "question", "questionSHA256",
    "requesterSenderId", "runId", "senderIsOwner", "sessionId", "sessionKey", "workspaceDir",
  ];
  const proofKeys = proof && typeof proof === "object" && !Array.isArray(proof)
    ? Object.keys(proof).sort()
    : [];
  const exactProofShape = proofKeys.length === expectedProofKeys.length &&
    proofKeys.every((key, index) => key === expectedProofKeys[index]);
  const sessionKey = cleanSingleLine(proof?.sessionKey, 1200);
  const sessionId = cleanSingleLine(proof?.sessionId, 512);
  const requesterSenderId = normalizeHandle(proof?.requesterSenderId);
  const runId = cleanSingleLine(proof?.runId, 512);
  const rawQuestion = typeof proof?.question === "string" && proof.question.length <= 4000
    ? proof.question
    : "";
  const question = cleanPrompt(rawQuestion);
  const questionSHA256 = exactDigest(proof?.questionSHA256);
  const audience = classifySession(sessionKey);
  const audienceFingerprint = exactDigest(proof?.audienceFingerprint);
  const ownerBoundary = audience === "approved_direct"
    ? proof?.senderIsOwner === false
    : audience === "approved_group" && typeof proof?.senderIsOwner === "boolean";
  if (!proof || !Object.isFrozen(proof) || !exactProofShape || proof.contract !== ORIGIN_BRIDGE_CONTRACT ||
      proof.agentId !== EXPECTED_AGENT_ID || proof.workspaceDir !== EXPECTED_WORKSPACE ||
      !sessionKey || !sessionId || !requesterSenderId || !runId || !question || !ownerBoundary ||
      questionSHA256 !== messageHash(rawQuestion) || !audience ||
      proof?.audience !== audience || !audienceFingerprint ||
      /^(?:System|Developer|Assistant):[ \t]/u.test(question) ||
      /^<\|(?:im_start|system|developer|assistant)/u.test(question)) {
    throw coded("escalation_origin_proof_invalid");
  }
  return Object.freeze({
    runId,
    question,
    questionSHA256,
    audience,
    audienceFingerprint,
    audienceScope: audienceScope(sessionKey, sessionId, requesterSenderId),
  });
}

export {
  EXPECTED_AGENT_ID,
  EXPECTED_WORKSPACE,
  ORIGIN_BRIDGE_CONTRACT as RICO_ESCALATION_ORIGIN_CONTRACT,
  ORIGIN_BRIDGE_SYMBOL as RICO_ESCALATION_ORIGIN_SYMBOL,
  TOOL_NAME as RICO_ESCALATION_TOOL_NAME,
};
