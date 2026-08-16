import { validateCurrentStatusRender } from "./RicoEscalationHandoff/result-contract.js";
import { canonicalJson, normalizePrincipal, sha256, validatePermissionGrant } from "./grant.mjs";

export const ANY_GROUP_ADAPTER_CONTRACT = "rico.ists-any-local-group-adapter/v2";
export const ANY_GROUP_SEND_CONTRACT = "rico.ists-any-local-group-send/v2";
export const ANY_GROUP_RECIPIENT_GUARD_EXCLUSION_CONTRACT = "rico.ists-any-local-group-recipient-guard-exclusion/v1";
export const ANY_GROUP_GLOBAL_LIMIT = 6;
export const ANY_GROUP_PER_GROUP_LIMIT = 2;
export const ANY_GROUP_RATE_WINDOW_MS = 10 * 60 * 1_000;

export function anyGroupPreflightRequest(grantInput) {
  const grant = requireAnyGroupGrant(grantInput);
  return deepFreeze({
    contract: ANY_GROUP_ADAPTER_CONTRACT,
    sourceAccount: grant.imessage.sourceAccount,
    anyLocalGroup: true,
    requiredCapabilities: [
      "messages.list.local-imessage-groups-read-only",
      "messages.read.exact-live-group-read-only",
      "messages.current-sender-live-participant",
      "messages.current-owner-live-participant",
      "recipient-guard.exact-policy-membership-read-only-exclusion",
      "messages.exclude-agent-authored-events",
      "messages.send.same-exact-group-ists-only",
      "messages.send.no-sms-fallback",
      "messages.send.delivered-acknowledgement",
      "messages.send.durable-idempotency",
      "messages.send.global-and-per-group-rate-limits",
    ],
  });
}

export function validateAnyGroupPreflight(input, grantInput) {
  const grant = requireAnyGroupGrant(grantInput);
  exactKeys(input, [
    "ok", "contract", "sourceAccount", "exactLocalSourceAccount", "readOnlyDiscovery",
    "liveMembershipRequired", "ownerMembershipRequired", "recipientGuardExclusionRequired",
    "fromMeExcluded", "sameGroupOnly", "noSmsFallback",
    "deliveredAcknowledgement", "durableIdempotency", "globalRateLimit", "perGroupRateLimit",
    "rateWindowMilliseconds", "generalRicoPolicyBroadened", "nativeAllowlistBroadened",
    "modelOrToolExecutionAllowed",
  ], "any group preflight");
  if (input.ok !== true || input.contract !== ANY_GROUP_ADAPTER_CONTRACT
    || normalizeEmail(input.sourceAccount) !== grant.imessage.sourceAccount
    || input.exactLocalSourceAccount !== true || input.readOnlyDiscovery !== true
    || input.liveMembershipRequired !== true || input.ownerMembershipRequired !== true
    || input.recipientGuardExclusionRequired !== true || input.fromMeExcluded !== true
    || input.sameGroupOnly !== true || input.noSmsFallback !== true
    || input.deliveredAcknowledgement !== true || input.durableIdempotency !== true
    || input.globalRateLimit !== ANY_GROUP_GLOBAL_LIMIT
    || input.perGroupRateLimit !== ANY_GROUP_PER_GROUP_LIMIT
    || input.rateWindowMilliseconds !== ANY_GROUP_RATE_WINDOW_MS
    || input.generalRicoPolicyBroadened !== false || input.nativeAllowlistBroadened !== false
    || input.modelOrToolExecutionAllowed !== false) throw coded("any_group_preflight_unproven");
  return true;
}

export function anyGroupListRequest(grantInput) {
  const grant = requireAnyGroupGrant(grantInput);
  return deepFreeze({
    contract: ANY_GROUP_ADAPTER_CONTRACT,
    sourceAccount: grant.imessage.sourceAccount,
    anyLocalGroup: true,
    channel: "imessage",
    groupOnly: true,
    readOnly: true,
    maxGroups: 10_000,
  });
}

export function validateAnyGroupList(input, grantInput) {
  const grant = requireAnyGroupGrant(grantInput);
  exactKeys(input, ["contract", "sourceAccount", "exactLocalSourceAccount", "readOnly", "groups"], "any group list");
  if (input.contract !== ANY_GROUP_ADAPTER_CONTRACT || normalizeEmail(input.sourceAccount) !== grant.imessage.sourceAccount
    || input.exactLocalSourceAccount !== true || input.readOnly !== true || !Array.isArray(input.groups)
    || input.groups.length > 10_000) throw coded("any_group_list_unproven");
  const groups = input.groups.map(validateDiscoveredGroup);
  const ids = groups.map((item) => item.chatRowId);
  if (new Set(ids).size !== ids.length) throw coded("any_group_list_duplicate");
  return Object.freeze(groups);
}

export function anyGroupReadRequest(grantInput, group, { afterAt = null, maxItems = 100 } = {}) {
  const grant = requireAnyGroupGrant(grantInput);
  const discovered = validateDiscoveredGroup(group);
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 100) throw coded("any_group_read_limit_invalid");
  return deepFreeze({
    contract: ANY_GROUP_ADAPTER_CONTRACT,
    sourceAccount: grant.imessage.sourceAccount,
    chatRowId: discovered.chatRowId,
    chatGuid: discovered.chatGuid,
    discoveryParticipantSnapshotSha256: discovered.participantSnapshotSha256,
    afterAt: afterAt === null ? null : iso(afterAt, "any_group_read_cursor_invalid"),
    maxItems,
    readOnly: true,
    excludeFromMe: true,
    executeMessageInstructions: false,
    attachments: false,
  });
}

export function validateAnyGroupRead(input, request) {
  exactKeys(input, ["contract", "sourceAccount", "readOnly", "group", "agentAuthoredExcluded", "messages"], "any group read");
  if (input.contract !== ANY_GROUP_ADAPTER_CONTRACT || normalizeEmail(input.sourceAccount) !== normalizeEmail(request.sourceAccount)
    || input.readOnly !== true || input.agentAuthoredExcluded !== true || !Array.isArray(input.messages)
    || input.messages.length > request.maxItems) throw coded("any_group_read_unproven");
  const group = validateLiveGroup(input.group);
  if (group.chatRowId !== request.chatRowId || group.chatGuid !== request.chatGuid
    || group.accountLogin !== normalizeEmail(request.sourceAccount)) throw coded("any_group_read_binding_mismatch");
  const messages = input.messages.map((item) => validateInboundGroupMessage(item, group));
  if (new Set(messages.map((item) => item.messageId)).size !== messages.length) throw coded("any_group_message_duplicate");
  return deepFreeze({ group, messages });
}

export function anyGroupRecipientGuardExclusionRequest(grantInput, { group, sender }) {
  const grant = requireAnyGroupGrant(grantInput);
  const binding = validateLiveGroup(group);
  const principal = normalizePrincipal(sender, "any group sender");
  if (!binding.participants.some((item) => samePrincipal(item, principal))
    || !binding.participants.some((item) => samePrincipal(item, grant.owner.principal))) {
    throw coded("any_group_required_membership_missing");
  }
  return deepFreeze({
    contract: ANY_GROUP_RECIPIENT_GUARD_EXCLUSION_CONTRACT,
    sourceAccount: grant.imessage.sourceAccount,
    group: binding,
    sender: principal,
    readOnly: true,
    exactPolicyAndMembershipRequired: true,
  });
}

export function validateAnyGroupRecipientGuardExclusionProof(input, request) {
  exactKeys(input, [
    "contract", "sourceAccount", "chatRowId", "chatGuid", "participantSnapshotSha256",
    "sender", "policySnapshotSha256", "recipientGuardPaused", "recipientGuardManaged",
    "recipientGuardAdmitted", "readOnly",
    "exactPolicyAndMembership",
  ], "any group recipient guard exclusion proof");
  const sender = normalizePrincipal(input.sender, "any group exclusion sender");
  if (input.contract !== ANY_GROUP_RECIPIENT_GUARD_EXCLUSION_CONTRACT
    || normalizeEmail(input.sourceAccount) !== normalizeEmail(request.sourceAccount)
    || input.chatRowId !== request.group.chatRowId || input.chatGuid !== request.group.chatGuid
    || input.participantSnapshotSha256 !== request.group.participantSnapshotSha256
    || !samePrincipal(sender, request.sender)
    || !/^[a-f0-9]{64}$/u.test(String(input.policySnapshotSha256 ?? ""))
    || typeof input.recipientGuardPaused !== "boolean"
    || typeof input.recipientGuardManaged !== "boolean"
    || typeof input.recipientGuardAdmitted !== "boolean"
    || (input.recipientGuardAdmitted && (!input.recipientGuardManaged || input.recipientGuardPaused))
    || input.readOnly !== true
    || input.exactPolicyAndMembership !== true) {
    throw coded("any_group_recipient_guard_exclusion_unproven");
  }
  return Object.freeze({
    recipientGuardPaused: input.recipientGuardPaused,
    recipientGuardManaged: input.recipientGuardManaged,
    recipientGuardAdmitted: input.recipientGuardAdmitted,
  });
}

export function buildAnyGroupSendRequest(grantInput, { group, sender, queryKind, render, eventHash }, renderOptions = {}) {
  const grant = requireAnyGroupGrant(grantInput);
  const binding = validateLiveGroup(group);
  const principal = normalizePrincipal(sender, "any group sender");
  if (!binding.participants.some((item) => samePrincipal(item, principal))
    || !binding.participants.some((item) => samePrincipal(item, grant.owner.principal))) {
    throw coded("any_group_required_membership_missing");
  }
  const provenRender = validateCurrentStatusRender(render, renderOptions);
  if (provenRender.subject !== "IMT or Command Center") throw coded("any_group_render_subject_invalid");
  const event = digest(eventHash, "any_group_event_hash_invalid");
  const payloadHash = sha256(canonicalJson({
    sourceAccount: grant.imessage.sourceAccount,
    chatRowId: binding.chatRowId,
    chatGuid: binding.chatGuid,
    participantSnapshotSha256: binding.participantSnapshotSha256,
    sender: principal,
    queryKind,
    render: provenRender,
    eventHash: event,
  }));
  const idempotencyKey = `rico:ists:any-group:${sha256(`any-group-send\0${payloadHash}`)}`;
  return deepFreeze({
    contract: ANY_GROUP_SEND_CONTRACT,
    sourceAccount: grant.imessage.sourceAccount,
    scope: "ists-current-status-answer-only",
    group: binding,
    sender: principal,
    queryKind,
    render: provenRender,
    text: provenRender.text,
    sourceRef: provenRender.sourceRef,
    eventHash: event,
    payloadHash,
    idempotencyKey,
    direction: "outbound",
    sameExactGroupOnly: true,
    noSmsFallback: true,
    requireDeliveredAcknowledgement: true,
    modelOrToolExecutionAllowed: false,
  });
}

export function validateAnyGroupSendRequest(input, grantInput, renderOptions = {}) {
  const expected = buildAnyGroupSendRequest(grantInput, input, renderOptions);
  if (canonicalJson(input) !== canonicalJson(expected)) throw coded("any_group_send_request_mismatch");
  return expected;
}

export function validateAnyGroupSendProof(input, request) {
  exactKeys(input, [
    "ok", "contract", "sourceAccount", "chatRowId", "chatGuid", "participantSnapshotSha256",
    "idempotencyKey", "transportMessageId", "deliveredAcknowledgement", "sameExactGroup",
    "noSmsFallback", "globalRateLimitEnforced", "perGroupRateLimitEnforced",
  ], "any group send proof");
  if (input.ok !== true || input.contract !== ANY_GROUP_SEND_CONTRACT
    || normalizeEmail(input.sourceAccount) !== normalizeEmail(request.sourceAccount)
    || input.chatRowId !== request.group.chatRowId || input.chatGuid !== request.group.chatGuid
    || input.participantSnapshotSha256 !== request.group.participantSnapshotSha256
    || input.idempotencyKey !== request.idempotencyKey
    || !bounded(input.transportMessageId, 1, 4_096, "any_group_transport_id_invalid")
    || input.deliveredAcknowledgement !== true || input.sameExactGroup !== true
    || input.noSmsFallback !== true || input.globalRateLimitEnforced !== true
    || input.perGroupRateLimitEnforced !== true) throw coded("any_group_send_proof_unproven");
  return Object.freeze({ transportMessageId: input.transportMessageId });
}

export function validateDiscoveredGroup(input) {
  exactKeys(input, [
    "chatRowId", "chatGuid", "accountLogin", "service", "isGroup",
    "participantSnapshotSha256", "lastMessageAt",
  ], "discovered group");
  const accountLogin = normalizeEmail(input.accountLogin);
  if (input.service !== "iMessage" || input.isGroup !== true || !accountLogin) throw coded("discovered_group_scope_invalid");
  return Object.freeze({
    chatRowId: positiveInteger(input.chatRowId, "discovered_group_chat_id_invalid"),
    chatGuid: bounded(input.chatGuid, 1, 4_096, "discovered_group_guid_invalid"),
    accountLogin,
    service: "iMessage",
    isGroup: true,
    participantSnapshotSha256: digest(input.participantSnapshotSha256, "discovered_group_participant_hash_invalid"),
    lastMessageAt: input.lastMessageAt === null ? null : iso(input.lastMessageAt, "discovered_group_last_message_invalid"),
  });
}

export function validateLiveGroup(input) {
  exactKeys(input, [
    "chatRowId", "chatGuid", "accountLogin", "service", "isGroup", "participants",
    "participantSnapshotSha256",
  ], "live group");
  const participants = canonicalLiveParticipants(input.participants);
  const snapshot = liveParticipantSnapshotSha256(participants);
  if (input.service !== "iMessage" || input.isGroup !== true || input.participantSnapshotSha256 !== snapshot) {
    throw coded("live_group_scope_invalid");
  }
  return Object.freeze({
    chatRowId: positiveInteger(input.chatRowId, "live_group_chat_id_invalid"),
    chatGuid: bounded(input.chatGuid, 1, 4_096, "live_group_guid_invalid"),
    accountLogin: normalizeEmail(input.accountLogin),
    service: "iMessage",
    isGroup: true,
    participants,
    participantSnapshotSha256: snapshot,
  });
}

export function canonicalLiveParticipants(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 100) throw coded("live_group_participants_invalid");
  const participants = input.map((item, index) => normalizePrincipal(item, `live group participant ${index}`))
    .sort((left, right) => `${left.kind}:${left.handle}`.localeCompare(`${right.kind}:${right.handle}`));
  if (new Set(participants.map((item) => `${item.kind}:${item.handle}`)).size !== participants.length) {
    throw coded("live_group_participants_duplicate");
  }
  return Object.freeze(participants);
}

export function liveParticipantSnapshotSha256(participants) {
  return sha256(canonicalJson(canonicalLiveParticipants(participants)));
}

function validateInboundGroupMessage(input, group) {
  exactKeys(input, ["messageId", "sentAt", "sender", "text", "fromMe"], "any group message");
  if (input.fromMe !== false) throw coded("any_group_agent_echo_not_excluded");
  const sender = normalizePrincipal(input.sender, "any group message sender");
  if (!group.participants.some((item) => samePrincipal(item, sender))) throw coded("any_group_sender_not_live");
  const text = String(input.text ?? "").normalize("NFKC");
  if (!text.trim() || text.length > 2_000 || /\u0000/u.test(text)) throw coded("any_group_message_text_invalid");
  return Object.freeze({
    messageId: bounded(input.messageId, 1, 4_096, "any_group_message_id_invalid"),
    sentAt: iso(input.sentAt, "any_group_message_time_invalid"),
    sender,
    text,
    fromMe: false,
  });
}

function requireAnyGroupGrant(input) {
  const grant = validatePermissionGrant(input);
  if (grant.schemaVersion !== 2 || grant.imessage.anyLocalGroup !== true) throw coded("any_local_group_not_authorized");
  return grant;
}

function samePrincipal(left, right) {
  return left?.kind === right?.kind && left?.handle === right?.handle;
}

function normalizeEmail(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(text) ? text : "";
}

function digest(value, code) {
  const text = String(value ?? "");
  if (!/^[a-f0-9]{64}$/u.test(text)) throw coded(code);
  return text;
}

function positiveInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw coded(code);
  return number;
}

function bounded(value, minimum, maximum, code) {
  const text = String(value ?? "").trim();
  if (text.length < minimum || text.length > maximum || /[\u0000-\u001f\u007f]/u.test(text)) throw coded(code);
  return text;
}

function iso(value, code) {
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
