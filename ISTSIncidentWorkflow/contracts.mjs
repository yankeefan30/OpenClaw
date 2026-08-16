import {
  ADAPTER_CONTRACT,
  COLLEAGUE_ZONE_CONTRACT,
  COLLEAGUE_ZONE_SOURCE_ID,
  COLLEAGUE_ZONE_URL,
  ISTS_DOMAIN_CONTEXT,
  RECIPIENT_GUARD_CONTRACT,
  RESEARCH_CONTRACT,
  SUMMARY_CONTRACT,
} from "./definition.mjs";
import {
  canonicalJson,
  canonicalParticipants,
  normalizePrincipal,
  participantSnapshotSha256,
  sha256,
  validatePermissionGrant,
} from "./grant.mjs";

const ALLOWED_EVENT_KINDS = new Set(["text", "attachment"]);
const FORBIDDEN_SOURCE_REFERENCE = /\b(?:limitless|plaud|transcript|recording|group\s+chat|imessage|text\s+thread|colleague\s+zone|servicenow|view\s+ai\s+insights|according\s+to\s+(?:the|an)|i\s+(?:saw|read|heard|learned))\b/iu;
const PUBLIC_CITATION_TYPES = Object.freeze([
  "website",
  "legal_case",
  "magazine_article",
  "newspaper_article",
  "book",
]);

export function validateAdapter(adapter, grantInput) {
  const grant = validatePermissionGrant(grantInput);
  if (!adapter || typeof adapter !== "object" || Array.isArray(adapter)) throw coded("adapter_missing");
  for (const method of [
    "preflight",
    "pollIncidentMessages",
    "readIncidentContext",
    "summarizeIncident",
    "pollActiveSENNotifications",
    "sendReviewedIMessage",
    "enqueueResearchHandoff",
  ]) {
    if (typeof adapter[method] !== "function") throw coded(`adapter_${method}_missing`);
  }
  return Object.freeze({ adapter, grant });
}

export function validateColleagueZoneAdapter(adapter, grantInput) {
  const grant = validatePermissionGrant(grantInput);
  if (!grant.colleagueZone.enabled) {
    if (adapter !== null && adapter !== undefined) throw coded("colleague_zone_adapter_unexpected");
    return null;
  }
  if (!adapter || typeof adapter !== "object" || Array.isArray(adapter)) throw coded("colleague_zone_adapter_missing");
  for (const method of ["preflight", "readActiveServiceStatus"]) {
    if (typeof adapter[method] !== "function") throw coded(`colleague_zone_adapter_${method}_missing`);
  }
  return adapter;
}

export function colleagueZoneReauthDescriptor(grantInput) {
  const grant = validatePermissionGrant(grantInput);
  if (!grant.colleagueZone.enabled) throw coded("colleague_zone_not_enabled");
  return deepFreeze({
    schema: "rico.colleague-zone-reauth",
    schemaVersion: 2,
    state: "user-action-required",
    url: grant.colleagueZone.pageUrl,
    instructions: "Complete sign-in and MFA interactively. Rico will not request, read, store, or replay your password or one-time code.",
    credentialHandling: "browser-managed-dedicated-profile",
    mfaHandling: "user-completed",
    daemonHeadlessReadAllowed: true,
    dedicatedBrowserProfileRequired: true,
    browserCookieInspectionOrExportAllowed: false,
    passwordOrOTPAutomationAllowed: false,
  });
}

export function colleagueZonePreflightRequest(grantInput) {
  const grant = validatePermissionGrant(grantInput);
  if (!grant.colleagueZone.enabled) throw coded("colleague_zone_not_enabled");
  return deepFreeze({
    contract: COLLEAGUE_ZONE_CONTRACT,
    sourceId: grant.colleagueZone.sourceId,
    pageUrl: grant.colleagueZone.pageUrl,
    profileId: grant.colleagueZone.profileId,
    requiredCapabilities: [
      "authenticated.read-only.service-status",
      "active.major-significant.only",
      "existing-ai-insights.read-if-present",
      "ai-insight-generation-disabled",
      "dedicated-playwright-persistent-profile",
      "browser-cookie-inspection-and-export-disabled",
      "mutation-requests-blocked-during-read",
      "no-password-or-otp-automation",
    ],
    interactiveReauthOnly: true,
    daemonBrowserAutomationAllowed: true,
    browserProfileMode: "dedicated-persistent",
    passwordOrOTPInputAllowed: false,
    browserCookieInspectionOrExportAllowed: false,
    sessionStorage: "browser-managed-profile",
  });
}

export function validateColleagueZonePreflightProof(input, grantInput) {
  const grant = validatePermissionGrant(grantInput);
  if (!grant.colleagueZone.enabled) throw coded("colleague_zone_not_enabled");
  exactKeys(input, [
    "ok",
    "contract",
    "sourceId",
    "pageUrl",
    "profileId",
    "authenticationState",
    "authenticatedReadReady",
    "readOnly",
    "browserRuntimeState",
    "browserRuntimeErrorCode",
    "dedicatedPersistentProfile",
    "headlessReadOnly",
    "browserAutomationUsed",
    "cookiesReadOrExported",
    "passwordOrOTPHandled",
    "mutationRequestsBlocked",
    "credentialMaterialLogged",
    "aiInsightGenerationDisabled",
  ], "colleague zone preflight proof");
  if (input.contract !== COLLEAGUE_ZONE_CONTRACT
    || input.sourceId !== grant.colleagueZone.sourceId
    || input.pageUrl !== grant.colleagueZone.pageUrl
    || input.profileId !== grant.colleagueZone.profileId
    || input.readOnly !== true
    || input.dedicatedPersistentProfile !== true
    || input.headlessReadOnly !== true
    || input.browserAutomationUsed !== true
    || input.cookiesReadOrExported !== false
    || input.passwordOrOTPHandled !== false
    || input.mutationRequestsBlocked !== true
    || input.credentialMaterialLogged !== false
    || input.aiInsightGenerationDisabled !== true) throw coded("colleague_zone_preflight_unproven");
  if (input.browserRuntimeState === "ready" && input.browserRuntimeErrorCode !== null) {
    throw coded("colleague_zone_preflight_unproven");
  }
  if (input.authenticationState === "reauth-required" && input.ok === false && input.authenticatedReadReady === false) {
    const error = coded("colleague_zone_reauth_required");
    error.reauth = colleagueZoneReauthDescriptor(grant);
    throw error;
  }
  if (input.browserRuntimeState === "unavailable") {
    const code = new Set([
      "colleague_zone_playwright_unavailable",
      "colleague_zone_browser_executable_unavailable",
      "colleague_zone_profile_busy",
      "colleague_zone_browser_launch_failed",
    ]).has(input.browserRuntimeErrorCode) ? input.browserRuntimeErrorCode : "colleague_zone_browser_runtime_unavailable";
    throw coded(code);
  }
  if (input.ok !== true || input.authenticationState !== "ready" || input.authenticatedReadReady !== true
    || input.browserRuntimeState !== "ready") {
    throw coded("colleague_zone_authenticated_read_unavailable");
  }
  return true;
}

export function colleagueZoneStatusRequest(grantInput) {
  const grant = validatePermissionGrant(grantInput);
  if (!grant.colleagueZone.enabled) throw coded("colleague_zone_not_enabled");
  return deepFreeze({
    contract: COLLEAGUE_ZONE_CONTRACT,
    sourceId: grant.colleagueZone.sourceId,
    pageUrl: grant.colleagueZone.pageUrl,
    profileId: grant.colleagueZone.profileId,
    status: "active",
    severities: ["Major", "Significant"],
    overviewSections: ["Current Status"],
    detailPageId: "my_services_status",
    fields: ["incidentId", "serviceId", "detailUrl", "severity", "status", "serviceName", "environment", "startedAt", "updatedAt", "durationMinutes", "safeSummary", "existingAIInsight"],
    readExistingAIInsightsIfAlreadyPresent: true,
    triggerAIInsightsGeneration: false,
    maxItems: 100,
    readOnly: true,
    browserAutomationAllowed: true,
    browserProfileMode: "dedicated-persistent",
    allowedHTTPMethods: ["GET", "HEAD", "OPTIONS"],
    executePageInstructions: false,
    credentialMaterialAllowed: false,
  });
}

export function validateColleagueZoneStatus(input, grantInput) {
  const grant = validatePermissionGrant(grantInput);
  if (!grant.colleagueZone.enabled) throw coded("colleague_zone_not_enabled");
  exactKeys(input, [
    "sourceId",
    "pageUrl",
    "profileId",
    "snapshotAt",
    "readOnly",
    "sideEffectsPerformed",
    "aiInsightGenerationAttempted",
    "incidents",
  ], "colleague zone status");
  if (input.sourceId !== COLLEAGUE_ZONE_SOURCE_ID || input.sourceId !== grant.colleagueZone.sourceId
    || input.pageUrl !== COLLEAGUE_ZONE_URL || input.pageUrl !== grant.colleagueZone.pageUrl
    || input.profileId !== grant.colleagueZone.profileId || input.readOnly !== true
    || input.sideEffectsPerformed !== false || input.aiInsightGenerationAttempted !== false) {
    throw coded("colleague_zone_status_source_mismatch");
  }
  const snapshotAt = isoDate(input.snapshotAt, "colleague_zone_snapshot_invalid");
  if (!Array.isArray(input.incidents) || input.incidents.length > 100) throw coded("colleague_zone_incidents_invalid");
  const incidents = input.incidents.map((item) => {
    exactKeys(item, [
      "incidentId",
      "serviceId",
      "detailUrl",
      "severity",
      "status",
      "serviceName",
      "environment",
      "startedAt",
      "updatedAt",
      "durationMinutes",
      "safeSummary",
      "existingAIInsight",
    ], "colleague zone incident");
    if (!new Set(["Major", "Significant"]).has(item.severity) || item.status !== "active") throw coded("colleague_zone_incident_scope_invalid");
    const serviceId = bounded(item.serviceId, 1, 1_024, "colleague_zone_service_id_invalid");
    const detailUrl = validateColleagueZoneDetailURL(item.detailUrl, serviceId);
    const serviceName = bounded(item.serviceName, 1, 240, "colleague_zone_service_name_invalid");
    const environment = bounded(item.environment, 1, 120, "colleague_zone_environment_invalid");
    const durationMinutes = item.durationMinutes;
    if (durationMinutes !== null && (!Number.isInteger(durationMinutes) || durationMinutes < 0 || durationMinutes > 5_256_000)) {
      throw coded("colleague_zone_duration_invalid");
    }
    exactKeys(item.existingAIInsight, ["present", "safeSummary"], "colleague zone existing ai insight");
    let aiSummary = null;
    if (item.existingAIInsight.present === true) aiSummary = validateSafeFragment(item.existingAIInsight.safeSummary, "colleague_zone_ai_summary");
    else if (item.existingAIInsight.present !== false || item.existingAIInsight.safeSummary !== null) throw coded("colleague_zone_ai_insights_invalid");
    return Object.freeze({
      incidentId: bounded(item.incidentId, 1, 4_096, "colleague_zone_incident_id_invalid"),
      serviceId,
      detailUrl,
      severity: item.severity,
      status: "active",
      serviceName,
      environment,
      startedAt: isoDate(item.startedAt, "colleague_zone_incident_started_at_invalid"),
      updatedAt: isoDate(item.updatedAt, "colleague_zone_incident_updated_at_invalid"),
      durationMinutes,
      safeSummary: validateSafeFragment(item.safeSummary, "colleague_zone_incident_summary"),
      existingAIInsight: Object.freeze({ present: item.existingAIInsight.present, safeSummary: aiSummary }),
    });
  });
  const unique = new Map();
  for (const incident of incidents) {
    const canonical = canonicalJson(incident);
    if (unique.has(incident.incidentId) && unique.get(incident.incidentId).canonical !== canonical) throw coded("colleague_zone_incident_identity_collision");
    unique.set(incident.incidentId, { canonical, incident });
  }
  return Object.freeze({ snapshotAt, incidents: [...unique.values()].map((entry) => entry.incident) });
}

export function preflightRequest(grantInput) {
  const grant = validatePermissionGrant(grantInput);
  return deepFreeze({
    contract: ADAPTER_CONTRACT,
    incidentChat: grant.incidentChat,
    jeff: grant.jeff,
    imessage: grant.imessage,
    sen: grant.sen,
    research: grant.research,
    requiredCapabilities: [
      "messages.read.exact-chat-snapshot",
      "messages.immutable-message-ids",
      "messages.exclude-agent-authored-events",
      "recipient-guard.reviewed-direct-send",
      "recipient-guard.delivered-ack",
      "recipient-guard.existing-rate-limits",
      "summary.no-private-source-reference",
      "research.no-outbound-security-or-credential-authority",
      ...(grant.sen.enabled ? ["outlook.active-sen.reviewed"] : []),
    ],
  });
}

export function validatePreflightProof(input, grantInput) {
  const grant = validatePermissionGrant(grantInput);
  exactKeys(input, ["ok", "contract", "chat", "jeff", "outlook", "capabilities"], "preflight proof");
  if (input.ok !== true || input.contract !== ADAPTER_CONTRACT) throw coded("preflight_contract_unproven");

  exactKeys(input.chat, [
    "chatId",
    "participantRevision",
    "participantSnapshotSha256",
    "exactBinding",
    "immutableMessageIds",
  ], "preflight chat");
  if (input.chat.chatId !== grant.incidentChat.chatId
    || input.chat.participantRevision !== grant.incidentChat.participantRevision
    || input.chat.participantSnapshotSha256 !== grant.incidentChat.participantSnapshotSha256
    || input.chat.exactBinding !== true
    || input.chat.immutableMessageIds !== true) throw coded("preflight_chat_unproven");

  exactKeys(input.jeff, ["profileId", "principal", "recipientGuardContract", "recipientGuardReady"], "preflight jeff");
  if (input.jeff.profileId !== grant.jeff.profileId
    || !principalsEqual(input.jeff.principal, grant.jeff.principal)
    || input.jeff.recipientGuardContract !== RECIPIENT_GUARD_CONTRACT
    || input.jeff.recipientGuardReady !== true) throw coded("preflight_jeff_unproven");

  exactKeys(input.capabilities, [
    "pollIncidentMessages",
    "readIncidentContext",
    "safeSummarization",
    "reviewedIMessageSend",
    "deliveredAcknowledgement",
    "agentAuthoredEventsExcluded",
    "existingRateLimitsEnforced",
    "researchHandoff",
  ], "preflight capabilities");
  if (Object.values(input.capabilities).some((value) => value !== true)) throw coded("preflight_capability_unproven");
  validateOutlookProof(input.outlook, grant.sen);
  return true;
}

function validateOutlookProof(input, sen) {
  exactKeys(input, ["enabled", "available", "mailboxId", "profileId", "reviewed", "activeNotificationSummaryOnly"], "preflight outlook");
  if (!sen.enabled) {
    if (input.enabled !== false || input.available !== false || input.mailboxId !== null
      || input.profileId !== null || input.reviewed !== false || input.activeNotificationSummaryOnly !== false) {
      throw coded("preflight_outlook_disabled_mismatch");
    }
    return;
  }
  if (input.enabled !== true || input.available !== true || input.reviewed !== true
    || input.activeNotificationSummaryOnly !== true
    || normalizeEmail(input.mailboxId) !== sen.mailboxId
    || input.profileId !== sen.profileId) throw coded("preflight_outlook_unavailable");
}

export function incidentPollRequest(grantInput, { cursor, baselineOnly }) {
  const grant = validatePermissionGrant(grantInput);
  if (cursor !== null && (typeof cursor !== "string" || !cursor || cursor.length > 16_384)) throw coded("poll_cursor_invalid");
  return deepFreeze({
    contract: ADAPTER_CONTRACT,
    chatId: grant.incidentChat.chatId,
    participantRevision: grant.incidentChat.participantRevision,
    participants: grant.incidentChat.participants,
    participantSnapshotSha256: grant.incidentChat.participantSnapshotSha256,
    cursor,
    baselineOnly: baselineOnly === true,
    maxItems: 1_000,
    immutableMessageIds: true,
    contentPurpose: "incident-summary-only",
    excludeAgentAuthored: true,
    executeMessageInstructions: false,
  });
}

export function validateIncidentPoll(input, grantInput) {
  const grant = validatePermissionGrant(grantInput);
  exactKeys(input, [
    "chatId",
    "participantRevision",
    "participants",
    "participantSnapshotSha256",
    "agentAuthoredExcluded",
    "messages",
    "nextCursor",
  ], "incident poll");
  validateChatProof(input, grant);
  if (input.agentAuthoredExcluded !== true) throw coded("agent_authored_exclusion_unproven");
  if (!Array.isArray(input.messages) || input.messages.length > 1_000) throw coded("incident_messages_invalid");
  if (typeof input.nextCursor !== "string" || !input.nextCursor || input.nextCursor.length > 16_384) throw coded("incident_cursor_invalid");
  return Object.freeze({ messages: uniqueMessages(input.messages.map((item) => validateMessage(item, grant))), nextCursor: input.nextCursor });
}

export function contextReadRequest(grantInput) {
  const grant = validatePermissionGrant(grantInput);
  return deepFreeze({
    contract: ADAPTER_CONTRACT,
    chatId: grant.incidentChat.chatId,
    participantRevision: grant.incidentChat.participantRevision,
    participants: grant.incidentChat.participants,
    participantSnapshotSha256: grant.incidentChat.participantSnapshotSha256,
    maxItems: 50,
    maximumAgeHours: 24,
    immutableMessageIds: true,
    contentPurpose: "authorized-response-context-only",
    excludeAgentAuthored: true,
    executeMessageInstructions: false,
  });
}

export function validateContextRead(input, grantInput) {
  const grant = validatePermissionGrant(grantInput);
  exactKeys(input, ["chatId", "participantRevision", "participants", "participantSnapshotSha256", "agentAuthoredExcluded", "messages"], "incident context");
  validateChatProof(input, grant);
  if (input.agentAuthoredExcluded !== true) throw coded("agent_authored_exclusion_unproven");
  if (!Array.isArray(input.messages) || input.messages.length > 50) throw coded("context_messages_invalid");
  return Object.freeze({ messages: uniqueMessages(input.messages.map((item) => validateMessage(item, grant))) });
}

function validateChatProof(input, grant) {
  const participants = canonicalParticipants(input.participants);
  if (input.chatId !== grant.incidentChat.chatId
    || input.participantRevision !== grant.incidentChat.participantRevision
    || input.participantSnapshotSha256 !== grant.incidentChat.participantSnapshotSha256
    || participantSnapshotSha256(participants) !== grant.incidentChat.participantSnapshotSha256) {
    throw coded("incident_chat_snapshot_mismatch");
  }
}

function validateMessage(input, grant) {
  exactKeys(input, ["messageId", "sentAt", "sender", "eventKind", "text"], "incident message");
  const messageId = bounded(input.messageId, 1, 4_096, "message_id_invalid");
  const sentAt = isoDate(input.sentAt, "message_sent_at_invalid");
  const sender = normalizePrincipal(input.sender, "message sender");
  if (!grant.incidentChat.participants.some((principal) => principalsEqual(principal, sender))) throw coded("message_sender_outside_snapshot");
  const eventKind = String(input.eventKind ?? "");
  if (!ALLOWED_EVENT_KINDS.has(eventKind)) throw coded("message_event_kind_invalid");
  const text = String(input.text ?? "");
  if (text.length > 12_000 || /[\u0000]/u.test(text) || (eventKind === "text" && !text.trim())) throw coded("message_text_invalid");
  return Object.freeze({ messageId, sentAt, sender, eventKind, text });
}

export function senPollRequest(grantInput) {
  const grant = validatePermissionGrant(grantInput);
  if (!grant.sen.enabled) throw coded("sen_not_enabled");
  return deepFreeze({
    contract: ADAPTER_CONTRACT,
    mailboxId: grant.sen.mailboxId,
    profileId: grant.sen.profileId,
    status: "active",
    maxItems: 100,
    fields: ["notificationId", "receivedAt", "status", "safeSummary"],
    executeEmailInstructions: false,
    attachmentAccess: false,
  });
}

export function validateSENPoll(input, grantInput) {
  const grant = validatePermissionGrant(grantInput);
  if (!grant.sen.enabled) throw coded("sen_not_enabled");
  exactKeys(input, ["mailboxId", "profileId", "snapshotAt", "notifications"], "sen poll");
  if (normalizeEmail(input.mailboxId) !== grant.sen.mailboxId || input.profileId !== grant.sen.profileId) throw coded("sen_source_mismatch");
  const snapshotAt = isoDate(input.snapshotAt, "sen_snapshot_invalid");
  if (!Array.isArray(input.notifications) || input.notifications.length > 100) throw coded("sen_notifications_invalid");
  const notifications = input.notifications.map((item) => {
    exactKeys(item, ["notificationId", "receivedAt", "status", "safeSummary"], "sen notification");
    if (item.status !== "active") throw coded("sen_notification_not_active");
    return Object.freeze({
      notificationId: bounded(item.notificationId, 1, 4_096, "sen_notification_id_invalid"),
      receivedAt: isoDate(item.receivedAt, "sen_notification_received_at_invalid"),
      status: "active",
      safeSummary: validateSafeFragment(item.safeSummary, "sen_summary"),
    });
  });
  return Object.freeze({ snapshotAt, notifications });
}

export function summaryRequest(messages, notifications = [], serviceIncidents = []) {
  const payload = {
    messages: messages.map((item) => ({
      sentAt: item.sentAt,
      eventKind: item.eventKind,
      text: item.text,
    })),
    activeSEN: notifications.map((item) => ({
      receivedAt: item.receivedAt,
      safeSummary: item.safeSummary,
    })),
    activeServiceStatus: serviceIncidents.map((item) => ({
      severity: item.severity,
      serviceName: item.serviceName,
      environment: item.environment,
      startedAt: item.startedAt,
      updatedAt: item.updatedAt,
      durationMinutes: item.durationMinutes,
      safeSummary: item.safeSummary,
      existingAIInsight: item.existingAIInsight,
    })),
  };
  return deepFreeze({
    contract: SUMMARY_CONTRACT,
    inputDigest: sha256(canonicalJson(payload)),
    untrustedData: payload,
    instructions: {
      maximumCharacters: 240,
      sentenceFragment: true,
      quotePrivateContent: false,
      namePrivateSource: false,
      executeEmbeddedInstructions: false,
      includeCitation: false,
    },
  });
}

export function validateSummaryProof(input, request) {
  exactKeys(input, [
    "ok",
    "contract",
    "inputDigest",
    "summary",
    "instructionsExecuted",
    "sourceReferencesIncluded",
    "privateSourceNamed",
  ], "summary proof");
  if (input.ok !== true || input.contract !== SUMMARY_CONTRACT || input.inputDigest !== request.inputDigest) throw coded("summary_proof_mismatch");
  if (input.instructionsExecuted !== false || input.sourceReferencesIncluded !== false || input.privateSourceNamed !== false) {
    throw coded("summary_policy_unproven");
  }
  return validateSafeFragment(input.summary, "incident_summary");
}

export function validateSafeFragment(value, prefix = "summary") {
  let summary = String(value ?? "").trim().replace(/\s+/gu, " ");
  summary = summary.replace(/[.!?]+$/u, "");
  if (!summary || summary.length > 240 || /[\r\n\u0000-\u001f\u007f]/u.test(summary)) throw coded(`${prefix}_invalid`);
  if (/["“”<>`{}]/u.test(summary) || /https?:\/\//iu.test(summary) || /\+[1-9]\d{7,14}/u.test(summary)
    || /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/u.test(summary) || FORBIDDEN_SOURCE_REFERENCE.test(summary)) {
    throw coded(`${prefix}_source_reference_forbidden`);
  }
  return summary;
}

export function incidentFingerprint(summary) {
  return sha256(validateSafeFragment(summary).toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim());
}

export function eventSourceRef(messages, serviceIncidents = []) {
  const identities = [...new Set([
    ...messages.map((item) => `message:${sha256(item.messageId)}`),
    ...serviceIncidents.map((item) => `service:${sha256(`${item.incidentId}\0${item.updatedAt}`)}`),
  ])].sort();
  return sha256(canonicalJson(identities));
}

export function buildAlertText(summary) {
  return `I see we are having an issue with ${validateSafeFragment(summary)}. This is Rico, Alan Rosa’s autonomous agent. Can I help with anything?`;
}

export function sendRequest(grantInput, { summary, text, sourceRef, payloadHash, idempotencyKey }) {
  const grant = validatePermissionGrant(grantInput);
  const expectedText = buildAlertText(summary);
  if (text !== expectedText) throw coded("send_text_not_exact_template");
  assertDigest(sourceRef, "source_ref_invalid");
  assertDigest(payloadHash, "payload_hash_invalid");
  if (!/^rico:ists:[a-f0-9]{64}$/u.test(idempotencyKey)) throw coded("idempotency_key_invalid");
  return deepFreeze({
    channel: "imessage",
    direction: "outbound",
    sourceAccount: grant.imessage.sourceAccount,
    recipient: { profileId: grant.jeff.profileId, principal: grant.jeff.principal },
    text,
    sourceRef,
    payloadHash,
    idempotencyKey,
    recipientGuard: {
      required: true,
      contract: grant.imessage.recipientGuardContract,
      exactDirectRecipientOnly: true,
      allowGroupExpansion: false,
      allowSmsFallback: false,
      requireDeliveredAcknowledgement: true,
      reuseExistingRateLimits: true,
    },
  });
}

export function validateSendProof(input, request) {
  exactKeys(input, [
    "ok",
    "channel",
    "sourceAccount",
    "recipient",
    "recipientGuardContract",
    "guardDecisionId",
    "idempotencyKey",
    "transportMessageId",
    "deliveredAck",
    "smsFallbackDisabled",
    "rateLimitsEnforced",
  ], "send proof");
  if (input.ok !== true || input.channel !== "imessage" || input.deliveredAck !== true
    || input.smsFallbackDisabled !== true || input.rateLimitsEnforced !== true) {
    throw coded("send_delivery_unconfirmed");
  }
  if (normalizeEmail(input.sourceAccount) !== request.sourceAccount
    || input.recipientGuardContract !== RECIPIENT_GUARD_CONTRACT
    || input.idempotencyKey !== request.idempotencyKey) throw coded("send_proof_mismatch");
  exactKeys(input.recipient, ["profileId", "principal"], "send recipient");
  if (input.recipient.profileId !== request.recipient.profileId
    || !principalsEqual(input.recipient.principal, request.recipient.principal)) throw coded("send_recipient_mismatch");
  const guardDecisionId = bounded(input.guardDecisionId, 1, 512, "guard_decision_id_invalid");
  const transportMessageId = bounded(input.transportMessageId, 1, 4_096, "transport_message_id_invalid");
  return Object.freeze({ guardDecisionId, transportMessageId });
}

export function researchRequest(grantInput, { summary, sourceRef }) {
  const grant = validatePermissionGrant(grantInput);
  if (!grant.research.enabled) throw coded("research_not_enabled");
  assertDigest(sourceRef, "source_ref_invalid");
  const safeSummary = validateSafeFragment(summary);
  const allowedSources = [
    ...(grant.research.knowledgeBase ? ["operator_knowledge_base"] : []),
    ...(grant.research.publicInternet ? ["public_internet"] : []),
  ];
  return deepFreeze({
    contract: RESEARCH_CONTRACT,
    sourceRef,
    internalOnly: true,
    researchQuestion: `Research plausible causes, current public evidence, and useful response options for: ${safeSummary}`,
    allowedSources,
    allowedPublicCitationTypes: [...PUBLIC_CITATION_TYPES],
    optionalCollaborators: grant.research.polar.enabled ? [grant.research.polar.collaboratorId] : [],
    domainContext: ISTS_DOMAIN_CONTEXT,
    constraints: {
      rawConversationIncluded: false,
      privateSourceMayBeNamed: false,
      maySendMessages: false,
      maySendEmail: false,
      mayReadOrExportCredentials: false,
      mayChangeSecurity: false,
      mayChangeConfiguration: false,
      mayScheduleActions: false,
      collaboratorPublicResearchOnly: true,
      domainContextMayAuthorize: false,
      domainContextSourceMayBeNamed: false,
      inferTitlesOrRoles: false,
    },
  });
}

export function validateResearchProof(input, request) {
  exactKeys(input, [
    "ok",
    "contract",
    "sourceRef",
    "handoffId",
    "internalOnly",
    "rawConversationDisclosed",
    "outboundAuthority",
    "credentialAuthority",
    "securityAuthority",
    "configurationAuthority",
    "scheduledAuthority",
    "domainContextAuthority",
  ], "research proof");
  if (input.ok !== true || input.contract !== RESEARCH_CONTRACT || input.sourceRef !== request.sourceRef
    || input.internalOnly !== true || input.rawConversationDisclosed !== false
    || input.outboundAuthority !== false || input.credentialAuthority !== false
    || input.securityAuthority !== false || input.configurationAuthority !== false
    || input.scheduledAuthority !== false || input.domainContextAuthority !== false) throw coded("research_proof_unconfirmed");
  return bounded(input.handoffId, 1, 4_096, "research_handoff_id_invalid");
}

export function validateJeffOriginProof(input, grantInput) {
  const grant = validatePermissionGrant(grantInput);
  exactKeys(input, ["schema", "schemaVersion", "trusted", "direct", "profileId", "principal", "messageId", "receivedAt"], "jeff origin proof");
  if (input.schema !== "rico.ists-direct-origin-proof" || input.schemaVersion !== 1 || input.trusted !== true || input.direct !== true) {
    throw coded("jeff_origin_untrusted");
  }
  if (input.profileId !== grant.jeff.profileId || !principalsEqual(input.principal, grant.jeff.principal)) throw coded("jeff_origin_mismatch");
  return Object.freeze({
    profileId: input.profileId,
    principal: normalizePrincipal(input.principal, "jeff origin principal"),
    messageId: bounded(input.messageId, 1, 4_096, "jeff_origin_message_id_invalid"),
    receivedAt: isoDate(input.receivedAt, "jeff_origin_received_at_invalid"),
  });
}

export function principalsEqual(left, right) {
  try {
    const a = normalizePrincipal(left, "left principal");
    const b = normalizePrincipal(right, "right principal");
    return a.kind === b.kind && a.handle === b.handle;
  } catch {
    return false;
  }
}

function uniqueMessages(messages) {
  const seen = new Map();
  const output = [];
  for (const message of messages) {
    const canonical = canonicalJson(message);
    if (seen.has(message.messageId)) {
      if (seen.get(message.messageId) !== canonical) throw coded("message_identity_collision");
      continue;
    }
    seen.set(message.messageId, canonical);
    output.push(message);
  }
  return output.sort((left, right) => Date.parse(left.sentAt) - Date.parse(right.sentAt));
}

function normalizeEmail(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized) ? normalized : "";
}

function validateColleagueZoneDetailURL(value, serviceId) {
  let url;
  try { url = new URL(String(value)); } catch { throw coded("colleague_zone_detail_url_invalid"); }
  if (url.protocol !== "https:" || url.hostname !== "colleaguezone.cvs.com" || url.pathname !== "/cz"
    || url.username || url.password || url.port || url.hash
    || url.searchParams.get("id") !== "my_services_status"
    || url.searchParams.get("service") !== serviceId
    || [...url.searchParams.keys()].sort().join(",") !== "id,service") {
    throw coded("colleague_zone_detail_url_invalid");
  }
  return url.toString();
}

function bounded(value, minimum, maximum, code) {
  const normalized = String(value ?? "").trim();
  if (normalized.length < minimum || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) throw coded(code);
  return normalized;
}

function isoDate(value, code) {
  const date = new Date(String(value ?? ""));
  if (!Number.isFinite(date.getTime())) throw coded(code);
  return date.toISOString();
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw coded(`${slug(label)}_invalid`);
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) throw coded(`${slug(label)}_fields_invalid`);
}

function assertDigest(value, code) {
  if (!/^[a-f0-9]{64}$/u.test(String(value ?? ""))) throw coded(code);
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_|_$/gu, "");
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
