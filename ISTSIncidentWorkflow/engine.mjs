import {
  buildAlertText,
  colleagueZonePreflightRequest,
  colleagueZoneStatusRequest,
  eventSourceRef,
  incidentFingerprint,
  incidentPollRequest,
  preflightRequest,
  researchRequest,
  sendRequest,
  senPollRequest,
  summaryRequest,
  validateAdapter,
  validateColleagueZoneAdapter,
  validateColleagueZonePreflightProof,
  validateColleagueZoneStatus,
  validateIncidentPoll,
  validatePreflightProof,
  validateResearchProof,
  validateSENPoll,
  validateSendProof,
  validateSummaryProof,
} from "./contracts.mjs";
import { canonicalJson, sha256, validatePermissionGrant } from "./grant.mjs";

export class ISTSIncidentEngine {
  constructor({ permissionGrant, adapter, colleagueZoneAdapter = null, store, now = () => new Date() }) {
    const validated = validateAdapter(adapter, permissionGrant);
    this.grant = validatePermissionGrant(validated.grant);
    this.adapter = validated.adapter;
    this.colleagueZoneAdapter = validateColleagueZoneAdapter(colleagueZoneAdapter, this.grant);
    this.store = store;
    this.now = now;
  }

  async verifyPreflight() {
    const proof = await this.adapter.preflight(preflightRequest(this.grant));
    validatePreflightProof(proof, this.grant);
    if (this.grant.colleagueZone.enabled) {
      const sourceProof = await this.colleagueZoneAdapter.preflight(colleagueZonePreflightRequest(this.grant));
      validateColleagueZonePreflightProof(sourceProof, this.grant);
    }
    return true;
  }

  async runOnce() {
    const unresolved = this.store.unresolvedReservations();
    if (unresolved.length > 0) throw coded("unresolved_delivery_reservation");
    await this.verifyPreflight();

    const state = this.store.load();
    const baselineOnly = state.initializedAt === null;
    const pollRequest = incidentPollRequest(this.grant, { cursor: state.cursor, baselineOnly });
    const poll = validateIncidentPoll(await this.adapter.pollIncidentMessages(pollRequest), this.grant);
    const serviceStatus = await this.#activeServiceStatus();
    const at = this.now().toISOString();
    const unique = unseenMessages(poll.messages, state, this.grant.incidentChat.chatId);
    const uniqueService = unseenServiceIncidents(serviceStatus, state, this.grant.colleagueZone);

    if (baselineOnly) {
      this.store.baseline({
        identityHashes: [...unique, ...uniqueService].map((item) => item.identityHash),
        cursor: poll.nextCursor,
        at,
      });
      return freezeResult({ baseline: true, inspected: poll.messages.length, serviceInspected: serviceStatus.length });
    }

    if (unique.length === 0 && uniqueService.length === 0) {
      this.store.advanceCursor({ cursor: poll.nextCursor, at, eventType: "empty_poll" });
      return freezeResult({ inspected: poll.messages.length, serviceInspected: serviceStatus.length });
    }

    const initializedAt = Date.parse(state.initializedAt);
    const fresh = unique.filter((item) => Date.parse(item.message.sentAt) > initializedAt);
    if (fresh.length === 0 && uniqueService.length === 0) {
      this.store.recordLateBaseline({ identityHashes: unique.map((item) => item.identityHash), cursor: poll.nextCursor, at });
      return freezeResult({ inspected: poll.messages.length, newMessages: unique.length });
    }

    const sen = await this.#activeSEN();
    const summaryInput = summaryRequest(
      fresh.map((item) => item.message),
      sen,
      uniqueService.map((item) => item.incident),
    );
    const summary = validateSummaryProof(await this.adapter.summarizeIncident(summaryInput), summaryInput);
    const fingerprint = incidentFingerprint(summary);
    const sourceRef = eventSourceRef(
      fresh.map((item) => item.message),
      uniqueService.map((item) => item.incident),
    );

    if (this.store.isIncidentInCooldown(fingerprint, at, this.grant.monitor.sameIncidentCooldownSeconds)) {
      this.store.suppressCooldown({
        identityHashes: [...fresh, ...uniqueService].map((item) => item.identityHash),
        incidentFingerprint: fingerprint,
        cursor: poll.nextCursor,
        at,
      });
      return freezeResult({
        inspected: poll.messages.length,
        newMessages: fresh.length,
        newServiceIncidents: uniqueService.length,
        suppressedCooldown: 1,
        incidentFingerprint: fingerprint,
      });
    }

    const text = buildAlertText(summary);
    const payloadHash = sha256(canonicalJson({
      channel: "imessage",
      sourceAccount: this.grant.imessage.sourceAccount,
      recipientProfileId: this.grant.jeff.profileId,
      recipient: this.grant.jeff.principal,
      text,
      sourceRef,
    }));
    const outboxKey = sha256(`ists-outbox\0${sourceRef}\0${payloadHash}`);
    const idempotencyKey = `rico:ists:${outboxKey}`;
    this.store.reserveDelivery({
      identityHashes: [...fresh, ...uniqueService].map((item) => item.identityHash),
      incidentFingerprint: fingerprint,
      outboxKey,
      payloadHash,
      idempotencyKey,
      sourceRef,
      at,
    });

    const research = await this.#startResearch({ summary, sourceRef, incidentFingerprint: fingerprint });
    const deliveryRequest = sendRequest(this.grant, { summary, text, sourceRef, payloadHash, idempotencyKey });
    try {
      const proof = validateSendProof(await this.adapter.sendReviewedIMessage(deliveryRequest), deliveryRequest);
      this.store.acknowledgeDelivery({
        outboxKey,
        transportMessageId: proof.transportMessageId,
        guardDecisionId: proof.guardDecisionId,
        cursor: poll.nextCursor,
        at: this.now().toISOString(),
      });
      return freezeResult({
        inspected: poll.messages.length,
        newMessages: fresh.length,
        newServiceIncidents: uniqueService.length,
        alertsConfirmed: 1,
        research,
        incidentFingerprint: fingerprint,
      });
    } catch (error) {
      this.store.quarantineDelivery({
        outboxKey,
        cursor: poll.nextCursor,
        errorCode: safeCode(error),
        at: this.now().toISOString(),
      });
      return freezeResult({
        inspected: poll.messages.length,
        newMessages: fresh.length,
        newServiceIncidents: uniqueService.length,
        deliveryUnknown: 1,
        research,
        incidentFingerprint: fingerprint,
      });
    }
  }

  async #activeSEN() {
    if (!this.grant.sen.enabled) return [];
    const request = senPollRequest(this.grant);
    const result = validateSENPoll(await this.adapter.pollActiveSENNotifications(request), this.grant);
    return result.notifications;
  }

  async #activeServiceStatus() {
    if (!this.grant.colleagueZone.enabled) return [];
    const request = colleagueZoneStatusRequest(this.grant);
    const result = validateColleagueZoneStatus(
      await this.colleagueZoneAdapter.readActiveServiceStatus(request),
      this.grant,
    );
    return result.incidents;
  }

  async #startResearch({ summary, sourceRef, incidentFingerprint: fingerprint }) {
    if (!this.grant.research.enabled) return "disabled";
    try {
      this.store.reserveResearch({ sourceRef, incidentFingerprint: fingerprint, at: this.now().toISOString() });
    } catch (error) {
      if (error?.code === "research_already_reserved") return "already-started";
      throw error;
    }
    try {
      const request = researchRequest(this.grant, { summary, sourceRef });
      const handoffId = validateResearchProof(await this.adapter.enqueueResearchHandoff(request), request);
      this.store.completeResearch({ sourceRef, handoffId, at: this.now().toISOString() });
      return "accepted";
    } catch (error) {
      this.store.failResearch({ sourceRef, errorCode: safeCode(error), at: this.now().toISOString() });
      return "failed";
    }
  }
}

function unseenMessages(messages, state, chatId) {
  const seen = new Set(state.messages.map((item) => item.identityHash));
  return messages
    .map((message) => ({ message, identityHash: sha256(`${chatId}\0${message.messageId}`) }))
    .filter((item) => !seen.has(item.identityHash));
}

function unseenServiceIncidents(incidents, state, source) {
  if (!source.enabled) return [];
  const seen = new Set(state.messages.map((item) => item.identityHash));
  return incidents
    .map((incident) => ({
      incident,
      identityHash: sha256(`${source.sourceId}\0${incident.incidentId}\0${incident.updatedAt}`),
    }))
    .filter((item) => !seen.has(item.identityHash));
}

function freezeResult({
  baseline = false,
  inspected = 0,
  serviceInspected = 0,
  newMessages = 0,
  newServiceIncidents = 0,
  alertsConfirmed = 0,
  deliveryUnknown = 0,
  suppressedCooldown = 0,
  research = "not-started",
  incidentFingerprint = null,
}) {
  return Object.freeze({
    status: deliveryUnknown > 0 ? "attention" : "ok",
    baseline,
    inspected,
    serviceInspected,
    newMessages,
    newServiceIncidents,
    alertsConfirmed,
    deliveryUnknown,
    suppressedCooldown,
    research,
    incidentFingerprint,
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
