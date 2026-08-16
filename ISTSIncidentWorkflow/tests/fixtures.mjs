import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { participantSnapshotSha256 } from "../grant.mjs";

export const ALAN_SOURCE = "alan.operator@example.test";
export const JEFF = Object.freeze({ kind: "phone", handle: "+12125550111" });
export const PARTICIPANTS = Object.freeze([
  Object.freeze({ kind: "phone", handle: "+12125550111" }),
  Object.freeze({ kind: "phone", handle: "+12125550122" }),
  Object.freeze({ kind: "email", handle: "incident.lead@example.test" }),
]);

export function permissionGrant(overrides = {}) {
  const base = {
    schema: "rico.ists-incident-grant",
    schemaVersion: 1,
    issuedAt: "2026-08-15T12:00:00.000Z",
    incidentChat: {
      chatId: "iMessage;-;fixture-ists-chat-guid",
      participantRevision: "fixture-revision-13-participants",
      participants: PARTICIPANTS,
      participantSnapshotSha256: participantSnapshotSha256(PARTICIPANTS),
    },
    jeff: {
      profileId: "fixture-contact-jeff-immutable",
      principal: JEFF,
    },
    imessage: {
      sourceAccount: ALAN_SOURCE,
      recipientGuardContract: "rico-recipient-guard/v6",
    },
    monitor: { sameIncidentCooldownSeconds: 900 },
    sen: { enabled: false },
    colleagueZone: { enabled: false },
    research: {
      enabled: true,
      publicInternet: true,
      knowledgeBase: true,
      polar: { enabled: true, collaboratorId: "grokbot:polar" },
    },
  };
  return merge(base, overrides);
}

export function incidentMessage({
  messageId = "fixture-message-1",
  sentAt = "2026-08-15T12:01:00.000Z",
  sender = PARTICIPANTS[1],
  eventKind = "text",
  text = "The authentication service is returning errors in production.",
} = {}) {
  return { messageId, sentAt, sender, eventKind, text };
}

export function fakeAdapter(grant, options = {}) {
  const calls = {
    preflight: [],
    polls: [],
    context: [],
    summaries: [],
    sen: [],
    sends: [],
    research: [],
  };
  const pollBatches = [...(options.pollBatches ?? [])];
  const adapter = {
    calls,
    async preflight(request) {
      calls.preflight.push(request);
      if (options.preflightError) throw options.preflightError;
      return options.preflightProof ?? preflightProof(grant);
    },
    async pollIncidentMessages(request) {
      calls.polls.push(request);
      const batch = pollBatches.shift() ?? { messages: [], nextCursor: `cursor-${calls.polls.length}` };
      return pollProof(grant, batch);
    },
    async readIncidentContext(request) {
      calls.context.push(request);
      return contextProof(grant, options.contextMessages ?? []);
    },
    async summarizeIncident(request) {
      calls.summaries.push(request);
      if (options.summaryError) throw options.summaryError;
      const summary = typeof options.summary === "function" ? options.summary(request) : (options.summary ?? "a production authentication failure affecting the ISTS portal");
      return {
        ok: true,
        contract: "rico.ists-safe-summary/v1",
        inputDigest: request.inputDigest,
        summary,
        instructionsExecuted: false,
        sourceReferencesIncluded: false,
        privateSourceNamed: false,
      };
    },
    async pollActiveSENNotifications(request) {
      calls.sen.push(request);
      if (options.senError) throw options.senError;
      return {
        mailboxId: grant.sen.enabled ? grant.sen.mailboxId : "disabled@example.test",
        profileId: grant.sen.enabled ? grant.sen.profileId : "disabled",
        snapshotAt: "2026-08-15T12:03:00.000Z",
        notifications: options.senNotifications ?? [],
      };
    },
    async sendReviewedIMessage(request) {
      calls.sends.push(request);
      if (options.sendError) throw options.sendError;
      const proof = {
        ok: true,
        channel: "imessage",
        sourceAccount: request.sourceAccount,
        recipient: request.recipient,
        recipientGuardContract: "rico-recipient-guard/v6",
        guardDecisionId: "fixture-guard-decision",
        idempotencyKey: request.idempotencyKey,
        transportMessageId: "fixture-transport-message",
        deliveredAck: true,
        smsFallbackDisabled: true,
        rateLimitsEnforced: true,
      };
      return { ...proof, ...(options.sendProofOverride ?? {}) };
    },
    async enqueueResearchHandoff(request) {
      calls.research.push(request);
      if (options.researchError) throw options.researchError;
      return {
        ok: true,
        contract: "rico.ists-research-handoff/v1",
        sourceRef: request.sourceRef,
        handoffId: "fixture-research-handoff",
        internalOnly: true,
        rawConversationDisclosed: false,
        outboundAuthority: false,
        credentialAuthority: false,
        securityAuthority: false,
        configurationAuthority: false,
        scheduledAuthority: false,
        domainContextAuthority: false,
      };
    },
  };
  return adapter;
}

export function serviceIncident({
  incidentId = "fixture-active-entry-1",
  serviceId = "fixture-opaque-service-id",
  severity = "Major",
  serviceName = "Identity Platform",
  environment = "Production",
  startedAt = "2026-08-15T12:01:00.000Z",
  updatedAt = "2026-08-15T12:02:00.000Z",
  durationMinutes = 1,
  safeSummary = "the production identity platform is experiencing elevated authentication failures",
  existingAIInsight = { present: false, safeSummary: null },
} = {}) {
  return {
    incidentId,
    serviceId,
    detailUrl: `https://colleaguezone.cvs.com/cz?id=my_services_status&service=${encodeURIComponent(serviceId)}`,
    severity,
    status: "active",
    serviceName,
    environment,
    startedAt,
    updatedAt,
    durationMinutes,
    safeSummary,
    existingAIInsight,
  };
}

export function fakeColleagueZoneAdapter(grant, options = {}) {
  const calls = { preflight: [], reads: [] };
  const statusBatches = [...(options.statusBatches ?? [])];
  return {
    calls,
    async preflight(request) {
      calls.preflight.push(request);
      if (options.preflightError) throw options.preflightError;
      return options.preflightProof ?? colleagueZonePreflightProof(grant);
    },
    async readActiveServiceStatus(request) {
      calls.reads.push(request);
      if (options.readError) throw options.readError;
      const incidents = statusBatches.shift() ?? [];
      return {
        sourceId: grant.colleagueZone.sourceId,
        pageUrl: grant.colleagueZone.pageUrl,
        profileId: grant.colleagueZone.profileId,
        snapshotAt: "2026-08-15T12:03:00.000Z",
        readOnly: true,
        sideEffectsPerformed: false,
        aiInsightGenerationAttempted: false,
        incidents,
        ...(options.statusOverride ?? {}),
      };
    },
  };
}

export function colleagueZonePreflightProof(grant, overrides = {}) {
  return merge({
    ok: true,
    contract: "rico.cvs-colleague-zone-status-adapter/v2",
    sourceId: grant.colleagueZone.sourceId,
    pageUrl: grant.colleagueZone.pageUrl,
    profileId: grant.colleagueZone.profileId,
    authenticationState: "ready",
    authenticatedReadReady: true,
    readOnly: true,
    browserRuntimeState: "ready",
    browserRuntimeErrorCode: null,
    dedicatedPersistentProfile: true,
    headlessReadOnly: true,
    browserAutomationUsed: true,
    cookiesReadOrExported: false,
    passwordOrOTPHandled: false,
    mutationRequestsBlocked: true,
    credentialMaterialLogged: false,
    aiInsightGenerationDisabled: true,
  }, overrides);
}

export function preflightProof(grant, overrides = {}) {
  const proof = {
    ok: true,
    contract: "rico.ists-incident-adapter/v1",
    chat: {
      chatId: grant.incidentChat.chatId,
      participantRevision: grant.incidentChat.participantRevision,
      participantSnapshotSha256: grant.incidentChat.participantSnapshotSha256,
      exactBinding: true,
      immutableMessageIds: true,
    },
    jeff: {
      profileId: grant.jeff.profileId,
      principal: grant.jeff.principal,
      recipientGuardContract: "rico-recipient-guard/v6",
      recipientGuardReady: true,
    },
    outlook: grant.sen.enabled ? {
      enabled: true,
      available: true,
      mailboxId: grant.sen.mailboxId,
      profileId: grant.sen.profileId,
      reviewed: true,
      activeNotificationSummaryOnly: true,
    } : {
      enabled: false,
      available: false,
      mailboxId: null,
      profileId: null,
      reviewed: false,
      activeNotificationSummaryOnly: false,
    },
    capabilities: {
      pollIncidentMessages: true,
      readIncidentContext: true,
      safeSummarization: true,
      reviewedIMessageSend: true,
        deliveredAcknowledgement: true,
        agentAuthoredEventsExcluded: true,
        existingRateLimitsEnforced: true,
        researchHandoff: true,
    },
  };
  return merge(proof, overrides);
}

export function pollProof(grant, { messages = [], nextCursor = "fixture-cursor", overrides = {} } = {}) {
  return merge({
    chatId: grant.incidentChat.chatId,
    participantRevision: grant.incidentChat.participantRevision,
    participants: grant.incidentChat.participants,
    participantSnapshotSha256: grant.incidentChat.participantSnapshotSha256,
    agentAuthoredExcluded: true,
    messages,
    nextCursor,
  }, overrides);
}

export function contextProof(grant, messages = []) {
  return {
    chatId: grant.incidentChat.chatId,
    participantRevision: grant.incidentChat.participantRevision,
    participants: grant.incidentChat.participants,
    participantSnapshotSha256: grant.incidentChat.participantSnapshotSha256,
    agentAuthoredExcluded: true,
    messages,
  };
}

export function jeffOriginProof(grant, overrides = {}) {
  return merge({
    schema: "rico.ists-direct-origin-proof",
    schemaVersion: 1,
    trusted: true,
    direct: true,
    profileId: grant.jeff.profileId,
    principal: grant.jeff.principal,
    messageId: "fixture-jeff-direct-message",
    receivedAt: "2026-08-15T12:05:00.000Z",
  }, overrides);
}

export function temporaryState() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rico-ists-test-"));
  fs.chmodSync(directory, 0o700);
  return {
    directory,
    statePath: path.join(directory, "state.json"),
    auditPath: path.join(directory, "audit.jsonl"),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

function merge(left, right) {
  if (!right || typeof right !== "object" || Array.isArray(right)) return right === undefined ? structuredClone(left) : right;
  const output = structuredClone(left);
  for (const [key, value] of Object.entries(right)) {
    if (value && typeof value === "object" && !Array.isArray(value) && output[key] && typeof output[key] === "object" && !Array.isArray(output[key])) {
      output[key] = merge(output[key], value);
    } else output[key] = structuredClone(value);
  }
  return output;
}
