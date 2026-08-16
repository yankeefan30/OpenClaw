import {
  colleagueZonePreflightRequest,
  colleagueZoneStatusRequest,
  contextReadRequest,
  preflightRequest,
  senPollRequest,
  validateAdapter,
  validateColleagueZoneAdapter,
  validateColleagueZonePreflightProof,
  validateColleagueZoneStatus,
  validateContextRead,
  validatePreflightProof,
  validateSafeFragment,
  validateSENPoll,
} from "./contracts.mjs";
import { canonicalJson, sha256, validatePermissionGrant } from "./grant.mjs";

const FORBIDDEN_REPLY_SOURCE = /\b(?:colleague\s+zone|servicenow|imessage|group\s+chat|text\s+thread|limitless|plaud|recording|transcript|according\s+to|i\s+(?:saw|read|heard|learned))\b/iu;

export class ISTSAnyGroupSourceProvider {
  constructor({ permissionGrant, adapter, colleagueZoneAdapter = null }) {
    const validated = validateAdapter(adapter, permissionGrant);
    this.grant = validatePermissionGrant(validated.grant);
    this.adapter = validated.adapter;
    this.colleagueZoneAdapter = validateColleagueZoneAdapter(colleagueZoneAdapter, this.grant);
  }

  async readDeterministicSnapshot() {
    validatePreflightProof(await this.adapter.preflight(preflightRequest(this.grant)), this.grant);
    if (this.grant.colleagueZone.enabled) {
      validateColleagueZonePreflightProof(
        await this.colleagueZoneAdapter.preflight(colleagueZonePreflightRequest(this.grant)),
        this.grant,
      );
    }
    const messages = validateContextRead(
      await this.adapter.readIncidentContext(contextReadRequest(this.grant)),
      this.grant,
    ).messages;
    const notifications = this.grant.sen.enabled
      ? validateSENPoll(
        await this.adapter.pollActiveSENNotifications(senPollRequest(this.grant)),
        this.grant,
      ).notifications
      : [];
    const serviceIncidents = this.grant.colleagueZone.enabled
      ? validateColleagueZoneStatus(
        await this.colleagueZoneAdapter.readActiveServiceStatus(colleagueZoneStatusRequest(this.grant)),
        this.grant,
      ).incidents
      : [];
    return buildDeterministicSnapshot({ messages, notifications, serviceIncidents });
  }
}

export function buildDeterministicSnapshot({ messages = [], notifications = [], serviceIncidents = [] } = {}) {
  const latestService = [...serviceIncidents]
    .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt))
    .at(-1);
  const latestNotification = [...notifications]
    .sort((left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt))
    .at(-1);
  let summary = null;
  let activeVerified = false;
  if (latestService) {
    summary = validateSafeFragment(latestService.safeSummary, "any_group_service_summary");
    activeVerified = true;
  } else if (latestNotification) {
    summary = validateSafeFragment(latestNotification.safeSummary, "any_group_sen_summary");
    activeVerified = true;
  } else if (messages.length > 0) {
    summary = classifyPrivateOperationalText(messages.map((item) => item.text).join(" "));
  }
  const sourceRef = sha256(canonicalJson({
    messages: messages.map((item) => sha256(item.messageId)).sort(),
    notifications: notifications.map((item) => sha256(item.notificationId)).sort(),
    serviceIncidents: serviceIncidents.map((item) => sha256(`${item.incidentId}\0${item.updatedAt}`)).sort(),
  }));
  return deepFreeze({
    schema: "rico.ists-deterministic-snapshot",
    schemaVersion: 1,
    summary,
    activeVerified,
    sourceRef,
    generatedWithoutModel: true,
    rawPrivateTextIncluded: false,
    sourceDisclosureForbidden: true,
  });
}

export function buildDeterministicGroupReply(queryKind, snapshot) {
  if (!new Set(["status", "resolution", "timing", "impact"]).has(queryKind)) {
    throw coded("any_group_query_kind_invalid");
  }
  const proven = validateDeterministicSnapshot(snapshot);
  const summary = proven.summary;
  let text;
  if (!summary) {
    text = queryKind === "resolution"
      ? "Rico: I do not have a verified active IMT issue or a confirmed resolution to report right now."
      : "Rico: I do not have a verified active IMT update to report right now.";
  } else if (queryKind === "resolution") {
    text = proven.activeVerified === true
      ? `Rico: I cannot confirm resolution; IMT’s current operational picture is ${summary}.`
      : `Rico: I cannot confirm resolution. IMT’s latest operational picture is ${summary}.`;
  } else if (queryKind === "timing") {
    text = `Rico: IMT’s current operational picture is ${summary}. I do not have a confirmed restoration time.`;
  } else if (queryKind === "impact") {
    text = `Rico: IMT’s current operational picture is ${summary}. I do not have a narrower confirmed impact statement.`;
  } else {
    text = `Rico: IMT’s current operational picture is ${summary}.`;
  }
  return validateDeterministicReplyText(text);
}

export function validateDeterministicSnapshot(snapshot) {
  exactKeys(snapshot, [
    "schema", "schemaVersion", "summary", "activeVerified", "sourceRef", "generatedWithoutModel",
    "rawPrivateTextIncluded", "sourceDisclosureForbidden",
  ], "any group deterministic snapshot");
  if (snapshot.schema !== "rico.ists-deterministic-snapshot" || snapshot.schemaVersion !== 1
    || typeof snapshot.activeVerified !== "boolean" || snapshot.generatedWithoutModel !== true
    || snapshot.rawPrivateTextIncluded !== false || snapshot.sourceDisclosureForbidden !== true
    || !/^[a-f0-9]{64}$/u.test(String(snapshot.sourceRef ?? ""))) {
    throw coded("any_group_snapshot_unproven");
  }
  return deepFreeze({
    schema: "rico.ists-deterministic-snapshot",
    schemaVersion: 1,
    summary: snapshot.summary === null ? null : validateSafeFragment(snapshot.summary, "any_group_reply_summary"),
    activeVerified: snapshot.activeVerified,
    sourceRef: snapshot.sourceRef,
    generatedWithoutModel: true,
    rawPrivateTextIncluded: false,
    sourceDisclosureForbidden: true,
  });
}

export function validateDeterministicReplyText(value) {
  const text = String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!text.startsWith("Rico: ") || text.length > 500 || /[\r\n\u0000-\u001f\u007f]/u.test(text)
    || /https?:\/\//iu.test(text) || /\+[1-9]\d{7,14}/u.test(text)
    || /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/u.test(text) || FORBIDDEN_REPLY_SOURCE.test(text)) {
    throw coded("any_group_reply_not_source_safe");
  }
  return text;
}

function classifyPrivateOperationalText(value) {
  const text = String(value ?? "").toLowerCase();
  if (/\b(auth(?:entication)?|login|sign[ -]?in|credential|sso|identity)\b/u.test(text)) {
    return "authentication failures affecting production access";
  }
  if (/\b(network|connect|dns|route|vpn|firewall)\b/u.test(text)) {
    return "a production network connectivity degradation";
  }
  if (/\b(latency|slow|delay|timeout|performance)\b/u.test(text)) {
    return "elevated latency affecting a production service";
  }
  if (/\b(outage|down|unavailable|offline|failure|error)\b/u.test(text)) {
    return "a production service availability degradation";
  }
  return "an active production service degradation under review";
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw coded(`${slug(label)}_invalid`);
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw coded(`${slug(label)}_fields_invalid`);
  }
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_|_$/gu, "");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
