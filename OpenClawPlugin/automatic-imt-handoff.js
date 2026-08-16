import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { isBoundedIMTQuestion } from "./ists-incident-integration.js";

const bundledShared = new URL("./RicoEscalationHandoff/automatic-imt.mjs", import.meta.url);
const bundledResultContract = new URL("./RicoEscalationHandoff/result-contract.js", import.meta.url);
const bundledHandoff = new URL("./RicoEscalationHandoff/handoff.js", import.meta.url);
const MAX_WAIT_MS = 90_000;
const RESULT_MAX_AGE_MS = 10 * 60 * 1000;
const MAX_EVENT_AGE_MS = 10 * 60 * 1000;
const MAX_EVENT_FUTURE_SKEW_MS = 2 * 60 * 1000;

let sharedModulePromise;
let resultModulePromise;
let handoffModulePromise;

function importBundled(moduleURL) {
  if (!fs.existsSync(fileURLToPath(moduleURL))) throw coded("automatic_imt_signed_module_unavailable");
  return import(moduleURL.href);
}

function loadSharedModule() {
  sharedModulePromise ??= importBundled(bundledShared);
  return sharedModulePromise;
}

function loadResultModule() {
  resultModulePromise ??= importBundled(bundledResultContract);
  return resultModulePromise;
}

function loadHandoffModule() {
  handoffModulePromise ??= importBundled(bundledHandoff);
  return handoffModulePromise;
}

export async function automaticIMTSignedClosureHealth({
  loadShared = loadSharedModule,
  loadResult = loadResultModule,
  loadHandoff = loadHandoffModule,
} = {}) {
  if ([loadShared, loadResult, loadHandoff].some((value) => typeof value !== "function")) {
    throw coded("automatic_imt_signed_module_unavailable");
  }
  const [shared, result, handoff] = await Promise.all([loadShared(), loadResult(), loadHandoff()]);
  if (typeof shared?.AutomaticIMTRequestRegistry !== "function" ||
      typeof shared?.automaticIMTIdempotencyKey !== "function" ||
      typeof shared?.automaticIMTRequestId !== "function" ||
      result?.CURRENT_STATUS_REQUEST_CONTRACT !== "imt-current-status/v1" ||
      typeof result?.renderCurrentStatusResult !== "function" ||
      typeof result?.validateCurrentStatusRender !== "function" ||
      typeof handoff?.EscalationHandoffStore !== "function" ||
      typeof handoff.EscalationHandoffStore.prototype?.submitWithId !== "function" ||
      typeof handoff.EscalationHandoffStore.prototype?.waitForResult !== "function") {
    throw coded("automatic_imt_signed_module_unavailable");
  }
  return Object.freeze({ ok: true, closure: "signed-nested" });
}

export function createAutomaticIMTHandoff({
  loadShared = loadSharedModule,
  loadResult = loadResultModule,
  loadHandoff = loadHandoffModule,
  createRegistry,
  createStore,
  now = () => Date.now(),
  maxWaitMs = MAX_WAIT_MS,
} = {}) {
  if ([loadShared, loadResult, loadHandoff, now].some((value) => typeof value !== "function") ||
      (createRegistry !== undefined && typeof createRegistry !== "function") ||
      (createStore !== undefined && typeof createStore !== "function") ||
      !Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > MAX_WAIT_MS) {
    throw coded("automatic_imt_config_invalid");
  }
  let registryPromise;
  let storePromise;

  async function registry(shared) {
    registryPromise ??= Promise.resolve(createRegistry
      ? createRegistry(shared)
      : new shared.AutomaticIMTRequestRegistry());
    const value = await registryPromise;
    if (!value || typeof value.claim !== "function" || typeof value.markSubmitted !== "function" ||
        typeof value.markTerminal !== "function") throw coded("automatic_imt_registry_unavailable");
    return value;
  }

  async function store() {
    storePromise ??= (async () => {
      if (createStore) return createStore();
      const module = await loadHandoff();
      if (typeof module?.EscalationHandoffStore !== "function") throw coded("automatic_imt_handoff_unavailable");
      return new module.EscalationHandoffStore();
    })();
    const value = await storePromise;
    if (!value || typeof value.submitWithId !== "function" || typeof value.waitForResult !== "function") {
      throw coded("automatic_imt_handoff_unavailable");
    }
    return value;
  }

  return Object.freeze({
    async responseForInbound({
      recipientGuardAdmitted = false,
      senderContext,
      inbound,
      hookContext,
      currentGroupMembership = false,
      revalidateAudience,
    } = {}) {
      const visibleQuestion = exactVisibleQuestion(inbound?.content);
      const isGroup = senderContext?.conversationType === "group";
      if (!isBoundedIMTQuestion(visibleQuestion, { requireRicoMention: isGroup })) return undefined;
      const exportRejected = containsUnsafeExportContent(visibleQuestion);

      let claim;
      let state;
      let claimedEventKey = "";
      let terminalized = false;
      try {
        if (recipientGuardAdmitted !== true || typeof revalidateAudience !== "function" ||
            !exactAudience(senderContext, hookContext, inbound, { currentGroupMembership })) {
          throw coded("automatic_imt_audience_unverified");
        }
        const sender = exactCorrelatedHandle(senderContext?.senderHandle, inbound?.senderId, hookContext?.senderId);
        if (!sender) throw coded("automatic_imt_sender_unverified");
        const sessionKey = exactSessionRoute(senderContext, inbound, hookContext);
        if (!sessionKey) throw coded("automatic_imt_session_unverified");
        const timestamp = trustedTimestamp(inbound?.timestamp);
        const currentTime = exactNow(now());
        if (timestamp < currentTime - MAX_EVENT_AGE_MS || timestamp > currentTime + MAX_EVENT_FUTURE_SKEW_MS) {
          throw coded("automatic_imt_timestamp_out_of_window");
        }
        const fingerprint = exactDigest(senderContext?.audienceFingerprint);
        const conversation = senderContext.conversationType === "group"
          ? String(senderContext.groupTarget)
          : `direct:${sender}`;
        const audience = senderContext.isOwner === true && senderContext.conversationType === "direct"
          ? "owner_private"
          : senderContext.conversationType === "group" ? "approved_group" : "approved_direct";
        const shared = await loadShared();
        if (typeof shared?.automaticIMTIdempotencyKey !== "function" ||
            typeof shared?.automaticIMTRequestId !== "function") throw coded("automatic_imt_shared_contract_unavailable");
        const identity = shared.automaticIMTIdempotencyKey({
          conversation,
          sender,
          timestamp,
          content: visibleQuestion,
        });
        const audienceScope = sha256([
          identity.eventKey,
          sessionKey,
          sender,
          fingerprint,
        ].join("\0"));
        const deterministicRequestId = shared.automaticIMTRequestId({
          eventKey: identity.eventKey,
          audienceScope,
          timestamp,
        });
        state = await registry(shared);
        claim = await state.claim({
          eventKey: identity.eventKey,
          dedupeKey: identity.dedupeKey,
          audienceFingerprint: fingerprint,
          audienceScope,
          requestId: deterministicRequestId,
          at: new Date(currentTime),
        });
        if (claim.disposition === "duplicate" || claim.disposition === "quarantined") return handled();
        if (claim.disposition === "rate_limited") {
          if (claim.eventKey !== identity.eventKey) throw coded("automatic_imt_claim_invalid");
          terminalized = true;
          return handled(shared.AUTOMATIC_IMT_UNVERIFIED_REPLY);
        }
        claimedEventKey = String(claim.eventKey ?? "");
        if (exportRejected) {
          await markTerminalDurably(state, {
            eventKey: claimedEventKey,
            outcome: "unverified",
            at: new Date(exactNow(now())),
          });
          terminalized = true;
          return handled(shared.AUTOMATIC_IMT_UNVERIFIED_REPLY);
        }

        const handoff = await store();
        let requestId;
        let scope;
        let eventKey;
        if (claim.disposition === "resume") {
          requestId = claim.requestId;
          scope = claim.audienceScope;
          eventKey = claim.eventKey;
        } else if (claim.disposition === "new" || claim.disposition === "recover") {
          const resultContract = await loadResult();
          if (resultContract?.CURRENT_STATUS_REQUEST_CONTRACT !== "imt-current-status/v1") {
            throw coded("automatic_imt_result_contract_unavailable");
          }
          await handoff.submitWithId({
            requestId: claim.requestId,
            question: visibleQuestion,
            audience,
            audienceScope: claim.audienceScope,
            alreadyTried: [...shared.AUTOMATIC_IMT_ALREADY_TRIED],
            doneLooksLike: shared.AUTOMATIC_IMT_DONE_LOOKS_LIKE,
            resultContract: resultContract.CURRENT_STATUS_REQUEST_CONTRACT,
          });
          const recorded = await state.markSubmitted({
            eventKey: claim.eventKey,
            requestId: claim.requestId,
            at: new Date(exactNow(now())),
          });
          requestId = recorded.requestId;
          scope = recorded.audienceScope;
          eventKey = recorded.eventKey;
        } else {
          throw coded("automatic_imt_claim_invalid");
        }

        const value = await handoff.waitForResult(requestId, scope, { maxWaitMs });
        const stillAuthorized = await revalidateAudience();
        if (stillAuthorized !== true) {
          await markTerminalDurably(state, {
            eventKey,
            outcome: "failed",
            at: new Date(exactNow(now())),
          });
          terminalized = true;
          return handled();
        }
        if (value?.status !== "complete") {
          await markTerminalDurably(state, {
            eventKey,
            outcome: "unverified",
            at: new Date(exactNow(now())),
          });
          terminalized = true;
          return handled(shared.AUTOMATIC_IMT_UNVERIFIED_REPLY);
        }
        const resultContract = await loadResult();
        if (typeof resultContract?.renderCurrentStatusResult !== "function" ||
            typeof resultContract?.validateCurrentStatusRender !== "function") {
          throw coded("automatic_imt_result_contract_unavailable");
        }
        const renderNow = new Date(exactNow(now()));
        const rendered = resultContract.renderCurrentStatusResult(value, {
          subject: "IMT or Command Center",
          now: renderNow,
          maxAgeMs: RESULT_MAX_AGE_MS,
        });
        const proof = resultContract.validateCurrentStatusRender(rendered, {
          now: new Date(exactNow(now())),
          maxAgeMs: RESULT_MAX_AGE_MS,
        });
        const safeText = typeof proof?.text === "string" && proof.text.trim().startsWith("Rico: ")
          ? proof.text.trim()
          : shared.AUTOMATIC_IMT_UNVERIFIED_REPLY;
        await markTerminalDurably(state, {
          eventKey,
          outcome: proof.verified === true ? "complete" : "unverified",
          at: new Date(exactNow(now())),
        });
        terminalized = true;
        return handled(safeText);
      } catch {
        if (!terminalized && state && claimedEventKey) {
          try {
            await markTerminalDurably(state, {
              eventKey: claimedEventKey,
              outcome: "failed",
              at: new Date(exactNow(now())),
            });
            terminalized = true;
          } catch {
            return handled();
          }
        }
        if (!terminalized) return handled();
        try {
          if (typeof revalidateAudience === "function" && await revalidateAudience() !== true) return handled();
        } catch {
          return handled();
        }
        try {
          const shared = await loadShared();
          return handled(shared.AUTOMATIC_IMT_UNVERIFIED_REPLY);
        } catch {
          return handled(fallbackNeutral());
        }
      }
    },
  });
}

function handled(text) {
  return Object.freeze(text ? { handled: true, text } : { handled: true });
}

async function markTerminalDurably(state, value) {
  const recorded = await state.markTerminal(value);
  if (recorded?.eventKey !== value.eventKey || recorded?.outcome !== value.outcome) {
    throw coded("automatic_imt_terminal_unconfirmed");
  }
  return recorded;
}

function exactVisibleQuestion(value) {
  const text = String(value ?? "").normalize("NFC").trim();
  if (!text || text.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) return "";
  return text;
}

function containsUnsafeExportContent(value) {
  return (
    /(?:https?:\/\/|www\.)[^\s]+/iu.test(value) ||
    /\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\b/iu.test(value)
    || /\b(?:ists\s+incident\s+text|colleague\s*zone|service\s*now|servicenow|limitless|plaud)\b/iu.test(value)
    || /\b(?:include|expose|quote|read|reveal|search|show|use)\b[^\r\n]{0,80}\b(?:hidden|private|internal)(?:\s+[a-z-]+){0,3}\s+(?:chats?|context|data|emails?|instructions?|messages?|recordings?|sources?)\b/iu.test(value)
  );
}

function fallbackNeutral() {
  return "Rico: I couldn’t verify a current IMT or Command Center update within this response, so I won’t guess. Please ask Rico again.";
}

function exactAudience(context, hookContext, inbound, { currentGroupMembership }) {
  if (!context || !new Set(["direct", "group"]).has(context.conversationType) ||
      !exactDigest(context.audienceFingerprint) || !normalizeHandle(context.senderHandle) ||
      String(inbound?.channel ?? "").toLowerCase() !== "imessage" ||
      String(hookContext?.channelId ?? "").toLowerCase() !== "imessage") return false;
  if (context.conversationType === "direct") {
    return context.isOwner === true
      ? String(context.access ?? "").toLowerCase() === "owner"
      : context.isOwner === false && new Set(["approved", "trusted"]).has(String(context.access ?? "").toLowerCase());
  }
  return currentGroupMembership === true && typeof context.groupTarget === "string" &&
    /^chat_(?:id|guid|identifier):.+$/iu.test(context.groupTarget) &&
    new Set(["approved", "trusted", "approved_group_participant", "owner"]).has(String(context.access ?? "").toLowerCase());
}

function exactSessionRoute(context, inbound, hookContext) {
  const values = [inbound?.sessionKey, hookContext?.sessionKey]
    .filter((value) => value != null && String(value).trim() !== "")
    .map((value) => String(value).normalize("NFC").trim().toLowerCase());
  if (values.length === 0 || new Set(values).size !== 1) return "";
  const key = values[0];
  if (context.conversationType === "direct" && context.isOwner === true) {
    return /^agent:main:imessage:direct:[^\s]+$/u.test(key) ? key : "";
  }
  if (context.conversationType === "direct" && context.isOwner === false) {
    return /^agent:rico-shared:imessage:direct:[^\s]+$/u.test(key) ? key : "";
  }
  return context.conversationType === "group" && /^agent:rico-shared:imessage:group:[^\s]+$/u.test(key) ? key : "";
}

function exactCorrelatedHandle(...values) {
  const normalized = values.filter((value) => value != null && String(value).trim() !== "").map(normalizeHandle);
  return normalized.length >= 2 && normalized.every(Boolean) && new Set(normalized).size === 1 ? normalized[0] : "";
}

function normalizeHandle(value) {
  const text = String(value ?? "").normalize("NFC").trim().toLowerCase();
  if (/^\+[1-9][0-9]{6,14}$/u.test(text)) return text;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(text) && text.length <= 254) return text;
  return "";
}

function trustedTimestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw coded("automatic_imt_timestamp_invalid");
  const milliseconds = number < 10_000_000_000 ? number * 1000 : number;
  if (!Number.isSafeInteger(milliseconds)) throw coded("automatic_imt_timestamp_invalid");
  return milliseconds;
}

function exactDigest(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/u.test(text) ? text : "";
}

function exactNow(value) {
  const number = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(number) || number < 0) throw coded("automatic_imt_clock_invalid");
  return number;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
