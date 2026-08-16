import {
  anyGroupListRequest,
  anyGroupPreflightRequest,
  anyGroupReadRequest,
  anyGroupRecipientGuardExclusionRequest,
  buildAnyGroupSendRequest,
  validateAnyGroupList,
  validateAnyGroupPreflight,
  validateAnyGroupRead,
  validateAnyGroupRecipientGuardExclusionProof,
  validateAnyGroupSendProof,
} from "./any-group-contracts.mjs";
import { classifyAnyGroupIMTQuery } from "./any-group-classifier.mjs";
import {
  canonicalJson,
  polarResearchAuthorized,
  sha256,
  validatePermissionGrant,
} from "./grant.mjs";
import {
  AUTOMATIC_IMT_ALREADY_TRIED,
  AUTOMATIC_IMT_DONE_LOOKS_LIKE,
  automaticIMTIdempotencyKey,
  automaticIMTRequestId,
} from "./RicoEscalationHandoff/automatic-imt.mjs";
import {
  CURRENT_STATUS_REQUEST_CONTRACT,
  renderCurrentStatusResult,
  validateCurrentStatusRender,
} from "./RicoEscalationHandoff/result-contract.js";

const HANDOFF_WAIT_MS = 90_000;
const CURRENT_STATUS_MAX_AGE_MS = 10 * 60 * 1_000;
const INBOUND_MAX_AGE_MS = 10 * 60 * 1_000;
const INBOUND_FUTURE_SKEW_MS = 2 * 60 * 1_000;
const CURRENT_STATUS_SUBJECT = "IMT or Command Center";

export class ISTSAnyGroupIngressEngine {
  constructor({
    permissionGrant,
    groupAdapter,
    store,
    handoffStore,
    requestRegistry,
    now = () => new Date(),
    renderResult = renderCurrentStatusResult,
    validateRender = validateCurrentStatusRender,
  }) {
    this.grant = validatePermissionGrant(permissionGrant);
    if (this.grant.schemaVersion !== 2 || this.grant.imessage.anyLocalGroup !== true) {
      throw coded("any_local_group_not_authorized");
    }
    if (!polarResearchAuthorized(this.grant)) {
      throw coded("any_local_group_polar_not_authorized");
    }
    requireGroupAdapter(groupAdapter);
    this.groupAdapter = groupAdapter;
    this.store = store;
    requireHandoffStore(handoffStore);
    requireRequestRegistry(requestRegistry);
    if (typeof renderResult !== "function" || typeof validateRender !== "function") {
      throw coded("any_group_result_renderer_missing");
    }
    this.handoffStore = handoffStore;
    this.requestRegistry = requestRegistry;
    this.renderResult = renderResult;
    this.validateRender = validateRender;
    this.now = now;
  }

  async runOnce() {
    validateAnyGroupPreflight(
      await this.groupAdapter.preflightAnyLocalGroups(anyGroupPreflightRequest(this.grant)),
      this.grant,
    );
    const groups = validateAnyGroupList(
      await this.groupAdapter.listLocalIMessageGroups(anyGroupListRequest(this.grant)),
      this.grant,
    );
    const state = this.store.load();
    if (state.initializedAt === null) return this.#baseline(groups);

    const seen = new Set(state.seen.map((entry) => entry.eventHash));
    let inspected = 0;
    let qualified = 0;
    let delivered = 0;
    let outcomeUnknown = 0;
    let rejected = 0;
    for (const discovered of groups) {
      const groupKey = groupIdentityHash(discovered);
      const request = anyGroupReadRequest(this.grant, discovered, {
        afterAt: state.groups[groupKey]?.cursorAt ?? state.initializedAt,
        maxItems: 100,
      });
      const read = validateAnyGroupRead(await this.groupAdapter.readLocalGroupMessages(request), request);
      const events = read.messages.map((message) => ({
        message,
        eventHash: messageIdentityHash(read.group, message),
      })).filter((item) => !seen.has(item.eventHash));
      inspected += events.length;
      const observedHashes = [];
      let retryableProofFailure = false;
      for (const event of events) {
        const receivedAtMs = Date.parse(event.message.sentAt);
        const currentMs = exactNow(this.now()).getTime();
        if (!Number.isFinite(receivedAtMs)
          || receivedAtMs < currentMs - INBOUND_MAX_AGE_MS
          || receivedAtMs > currentMs + INBOUND_FUTURE_SKEW_MS) {
          observedHashes.push(event.eventHash);
          rejected += 1;
          continue;
        }
        const senderHash = sha256(canonicalJson(event.message.sender));
        const followupEligible = this.store.followupEligible({
          groupKey,
          senderHash,
          at: event.message.sentAt,
        });
        const query = classifyAnyGroupIMTQuery(event.message.text, { followupEligible });
        if (!query) {
          observedHashes.push(event.eventHash);
          rejected += 1;
          continue;
        }
        qualified += 1;
        const exclusionRequest = anyGroupRecipientGuardExclusionRequest(this.grant, {
          group: read.group,
          sender: event.message.sender,
        });
        try {
          const exclusion = validateAnyGroupRecipientGuardExclusionProof(
            await this.groupAdapter.proveRecipientGuardExclusion(exclusionRequest),
            exclusionRequest,
          );
          if (exclusion.recipientGuardPaused || exclusion.recipientGuardManaged) {
            observedHashes.push(event.eventHash);
            rejected += 1;
            continue;
          }
        } catch (error) {
          if (recipientGuardSenderBlocked(error)) {
            observedHashes.push(event.eventHash);
            rejected += 1;
            continue;
          }
          // Without an exact read-only proof that Recipient Guard will not
          // answer this group, silence is safer than a delayed duplicate.
          retryableProofFailure = true;
          outcomeUnknown += 1;
          continue;
        }

        let research;
        try {
          research = await this.#research(event, read.group, groupKey, senderHash);
        } catch {
          // The durable research reservation could not be proven. Do not send
          // even a neutral response because at-most-once delivery is unknown.
          retryableProofFailure = true;
          outcomeUnknown += 1;
          continue;
        }
        if (research.suppressed) {
          observedHashes.push(event.eventHash);
          rejected += 1;
          continue;
        }

        // Recipient Guard or group membership may have changed during the
        // bounded research wait. Re-prove the exact current generation before
        // creating any outbound reservation.
        try {
          const currentExclusion = validateAnyGroupRecipientGuardExclusionProof(
            await this.groupAdapter.proveRecipientGuardExclusion(exclusionRequest),
            exclusionRequest,
          );
          if (currentExclusion.recipientGuardPaused || currentExclusion.recipientGuardManaged) {
            observedHashes.push(event.eventHash);
            await this.#terminal(research, "failed");
            rejected += 1;
            continue;
          }
        } catch (error) {
          observedHashes.push(event.eventHash);
          await this.#terminal(research, "failed");
          if (recipientGuardSenderBlocked(error)) rejected += 1;
          else outcomeUnknown += 1;
          continue;
        }

        observedHashes.push(event.eventHash);
        let reservedOutboxKey = null;
        try {
          const send = buildAnyGroupSendRequest(this.grant, {
            group: read.group,
            sender: event.message.sender,
            queryKind: query.kind,
            render: research.render,
            eventHash: event.eventHash,
          }, { now: exactNow(this.now()), maxAgeMs: CURRENT_STATUS_MAX_AGE_MS });
          const outboxKey = sha256(send.idempotencyKey);
          reservedOutboxKey = outboxKey;
          this.store.reserve({
            eventHash: event.eventHash,
            outboxKey,
            payloadHash: send.payloadHash,
            groupKey,
            senderHash,
            queryKind: query.kind,
            at: this.now().toISOString(),
          });
          const proof = validateAnyGroupSendProof(
            await this.groupAdapter.sendSameGroupIncidentReply(send),
            send,
          );
          this.store.complete({
            outboxKey,
            outcomeCode: "delivered",
            acknowledgementHash: sha256(proof.transportMessageId),
            at: this.now().toISOString(),
          });
          await this.#terminal(research, research.render.verified ? "complete" : "unverified");
          delivered += 1;
        } catch (error) {
          if (reservedOutboxKey) {
            try {
              this.store.complete({
                outboxKey: reservedOutboxKey,
                outcomeCode: safeCode(error),
                at: this.now().toISOString(),
              });
            } catch {}
          }
          await this.#terminal(research, "failed");
          if (recipientGuardSenderBlocked(error)) rejected += 1;
          else outcomeUnknown += 1;
        }
      }
      const priorCursor = state.groups[groupKey]?.cursorAt ?? state.initializedAt;
      const cursorAt = retryableProofFailure
        ? priorCursor
        : latestCursor(read.messages, discovered.lastMessageAt, priorCursor);
      this.store.markSeen({
        groupKey,
        cursorAt,
        eventHashes: observedHashes,
        at: this.now().toISOString(),
      });
      observedHashes.forEach((hash) => seen.add(hash));
    }
    return freezeResult({ inspected, qualified, delivered, outcomeUnknown, rejected });
  }

  async #research(event, group, groupKey, senderHash) {
    const idempotency = automaticIMTIdempotencyKey({
      conversation: groupKey,
      sender: event.message.sender.handle,
      timestamp: Date.parse(event.message.sentAt),
      content: event.message.text,
    });
    const audienceFingerprint = sha256(canonicalJson({
      sourceAccount: group.accountLogin,
      groupKey,
      participantSnapshotSha256: group.participantSnapshotSha256,
    }));
    const audienceScope = sha256(canonicalJson({
      contract: CURRENT_STATUS_REQUEST_CONTRACT,
      sourceAccount: group.accountLogin,
      groupKey,
      participantSnapshotSha256: group.participantSnapshotSha256,
      senderHash,
      eventHash: event.eventHash,
    }));
    const requestId = automaticIMTRequestId({
      eventKey: idempotency.eventKey,
      audienceScope,
      timestamp: idempotency.timestampMs,
    });
    const claimedAt = exactNow(this.now()).toISOString();
    const claim = await this.requestRegistry.claim({
      eventKey: idempotency.eventKey,
      dedupeKey: idempotency.dedupeKey,
      audienceFingerprint,
      audienceScope,
      requestId,
      at: claimedAt,
    });
    if (new Set(["duplicate", "quarantined"]).has(claim.disposition)) {
      return Object.freeze({ suppressed: true });
    }
    if (claim.disposition === "rate_limited") {
      const renderedAt = exactNow(this.now());
      const render = this.validateRender(this.renderResult(null, {
        subject: CURRENT_STATUS_SUBJECT,
        now: renderedAt,
        maxAgeMs: CURRENT_STATUS_MAX_AGE_MS,
      }), { now: renderedAt, maxAgeMs: CURRENT_STATUS_MAX_AGE_MS });
      return Object.freeze({ suppressed: false, eventKey: idempotency.eventKey, render });
    }
    if (!new Set(["new", "recover", "resume"]).has(claim.disposition)
      || claim.eventKey !== idempotency.eventKey || claim.requestId !== requestId
      || claim.audienceScope !== audienceScope) throw coded("any_group_handoff_claim_invalid");

    if (claim.disposition !== "resume") {
      await this.handoffStore.submitWithId({
        requestId,
        question: event.message.text,
        audience: "authorized_any_local_group",
        audienceScope,
        alreadyTried: [...AUTOMATIC_IMT_ALREADY_TRIED],
        doneLooksLike: AUTOMATIC_IMT_DONE_LOOKS_LIKE,
        resultContract: CURRENT_STATUS_REQUEST_CONTRACT,
      });
      await this.requestRegistry.markSubmitted({
        eventKey: idempotency.eventKey,
        requestId,
        at: exactNow(this.now()).toISOString(),
      });
    }

    let value;
    try {
      value = await this.handoffStore.waitForResult(requestId, audienceScope, { maxWaitMs: HANDOFF_WAIT_MS });
    } catch {
      value = null;
    }
    const renderedAt = exactNow(this.now());
    const render = this.validateRender(this.renderResult(value, {
      subject: CURRENT_STATUS_SUBJECT,
      now: renderedAt,
      maxAgeMs: CURRENT_STATUS_MAX_AGE_MS,
    }), { now: renderedAt, maxAgeMs: CURRENT_STATUS_MAX_AGE_MS });
    return Object.freeze({
      suppressed: false,
      eventKey: idempotency.eventKey,
      render,
    });
  }

  async #terminal(research, outcome) {
    if (!research?.eventKey) return;
    try {
      await this.requestRegistry.markTerminal({
        eventKey: research.eventKey,
        outcome,
        at: exactNow(this.now()).toISOString(),
      });
    } catch {
      // The transport outbox remains the final at-most-once authority. A
      // registry write failure must never cause a second send.
    }
  }

  async #baseline(groups) {
    const at = this.now().toISOString();
    const records = [];
    const eventHashes = [];
    let inspected = 0;
    for (const discovered of groups) {
      const request = anyGroupReadRequest(this.grant, discovered, { afterAt: null, maxItems: 100 });
      const read = validateAnyGroupRead(await this.groupAdapter.readLocalGroupMessages(request), request);
      inspected += read.messages.length;
      eventHashes.push(...read.messages.map((message) => messageIdentityHash(read.group, message)));
      records.push({
        groupKey: groupIdentityHash(discovered),
        cursorAt: latestCursor(read.messages, discovered.lastMessageAt, at),
      });
    }
    this.store.baseline({ groups: records, seenEventHashes: eventHashes, at });
    return freezeResult({ baseline: true, inspected });
  }
}

function recipientGuardSenderBlocked(error) {
  return error?.code === "any_group_recipient_guard_sender_blocked";
}

export function groupIdentityHash(group) {
  return sha256(`any-local-group\0${String(group.accountLogin).toLowerCase()}\0${group.chatGuid}`);
}

export function messageIdentityHash(group, message) {
  return sha256(`any-local-group-message\0${group.chatGuid}\0${message.messageId}`);
}

function latestCursor(messages, groupLastMessageAt, fallback) {
  const values = [groupLastMessageAt, fallback, ...messages.map((item) => item.sentAt)]
    .filter(Boolean)
    .map((item) => new Date(item))
    .filter((item) => Number.isFinite(item.getTime()))
    .sort((left, right) => left.getTime() - right.getTime());
  return values.at(-1)?.toISOString() ?? null;
}

function requireGroupAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") throw coded("any_group_adapter_missing");
  for (const method of [
    "preflightAnyLocalGroups", "listLocalIMessageGroups", "readLocalGroupMessages",
    "proveRecipientGuardExclusion", "sendSameGroupIncidentReply",
  ]) {
    if (typeof adapter[method] !== "function") throw coded(`any_group_adapter_${method}_missing`);
  }
}

function requireHandoffStore(value) {
  if (!value || typeof value.submitWithId !== "function" || typeof value.waitForResult !== "function") {
    throw coded("any_group_handoff_store_missing");
  }
}

function requireRequestRegistry(value) {
  if (!value || typeof value.claim !== "function" || typeof value.markSubmitted !== "function"
    || typeof value.markTerminal !== "function") throw coded("any_group_request_registry_missing");
}

function exactNow(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw coded("any_group_clock_invalid");
  return new Date(value);
}

function freezeResult({ baseline = false, inspected = 0, qualified = 0, delivered = 0, outcomeUnknown = 0, rejected = 0 }) {
  return Object.freeze({
    status: outcomeUnknown > 0 ? "attention" : "ok",
    baseline,
    inspected,
    qualified,
    delivered,
    outcomeUnknown,
    rejected,
    deterministicOnly: true,
    generalRicoPolicyBroadened: false,
  });
}

function safeCode(error) {
  return String(error?.code ?? error?.name ?? "unknown").toLowerCase().replace(/[^a-z0-9_-]+/gu, "_").slice(0, 80) || "unknown";
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
