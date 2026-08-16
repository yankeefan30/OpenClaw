import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveIMsgExecutable } from "../imsg-executable.mjs";
import {
  canonicalJson,
  canonicalParticipants,
  normalizePrincipal,
  participantSnapshotSha256,
  validatePermissionGrant,
} from "../grant.mjs";

const ADAPTER_CONTRACT = "rico.ists-incident-adapter/v1";
const RECIPIENT_GUARD_CONTRACT = "rico-recipient-guard/v6";
const SUMMARY_CONTRACT = "rico.ists-safe-summary/v1";
const RESEARCH_CONTRACT = "rico.ists-research-handoff/v1";
const DEFAULT_OPENCLAW = "/opt/homebrew/bin/openclaw";

export async function createISTSIncidentAdapter(context) {
  return new LocalISTSIncidentAdapter(context);
}

export class LocalISTSIncidentAdapter {
  constructor({
    permissionGrant,
    stateDirectory,
    imsgPath = undefined,
    openclawPath = DEFAULT_OPENCLAW,
    guardPolicyPath = defaultGuardPolicyPath(),
    run = runCommand,
    now = () => new Date(),
  }) {
    this.grant = validatePermissionGrant(permissionGrant);
    if (this.grant.schemaVersion !== 2 || !this.grant.owner) throw coded("ists_owner_scope_grant_required");
    this.stateDirectory = path.resolve(stateDirectory);
    this.imsgPath = resolveIMsgExecutable(imsgPath);
    this.openclawPath = privateExecutable(openclawPath, "openclaw_unavailable");
    this.guardPolicyPath = path.resolve(guardPolicyPath);
    this.run = run;
    this.now = now;
    this.chatRowId = exactChatRowId(this.grant.incidentChat.chatId);
  }

  async preflight(request) {
    requireExactBinding(request.incidentChat, this.grant.incidentChat, "preflight_chat_request_mismatch");
    requireExactPerson(request.jeff, this.grant.jeff, "preflight_jeff_request_mismatch");
    if (request.imessage?.sourceAccount !== this.grant.imessage.sourceAccount
      || request.imessage?.recipientGuardContract !== RECIPIENT_GUARD_CONTRACT) {
      throw coded("preflight_imessage_request_mismatch");
    }
    this._verifyGroupSnapshot();
    this._verifySourceAccount();
    this._verifyIMessageOnlyTransport();
    this._verifyRecipientPolicy();
    this._verifyLiveGuard();
    if (this.grant.sen.enabled) throw coded("sen_adapter_unavailable");
    return {
      ok: true,
      contract: ADAPTER_CONTRACT,
      chat: {
        chatId: this.grant.incidentChat.chatId,
        participantRevision: this.grant.incidentChat.participantRevision,
        participantSnapshotSha256: this.grant.incidentChat.participantSnapshotSha256,
        exactBinding: true,
        immutableMessageIds: true,
      },
      jeff: {
        profileId: this.grant.jeff.profileId,
        principal: this.grant.jeff.principal,
        recipientGuardContract: RECIPIENT_GUARD_CONTRACT,
        recipientGuardReady: true,
      },
      outlook: {
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
  }

  async pollIncidentMessages(request) {
    this._verifyReadRequest(request);
    const messages = this._readMessages(Math.min(Number(request.maxItems) || 1_000, 1_000));
    return this._readProof(messages, cursorFor(messages));
  }

  async readIncidentContext(request) {
    this._verifyReadRequest(request);
    const maximumAgeHours = Number(request.maximumAgeHours);
    if (!Number.isFinite(maximumAgeHours) || maximumAgeHours <= 0 || maximumAgeHours > 168) {
      throw coded("context_age_invalid");
    }
    const cutoff = this.now().getTime() - maximumAgeHours * 60 * 60 * 1_000;
    const messages = this._readMessages(Math.min(Number(request.maxItems) || 50, 50))
      .filter((item) => Date.parse(item.sentAt) >= cutoff);
    const proof = this._readProof(messages, cursorFor(messages));
    delete proof.nextCursor;
    return proof;
  }

  async summarizeIncident(request) {
    if (request?.contract !== SUMMARY_CONTRACT || !/^[a-f0-9]{64}$/u.test(String(request.inputDigest ?? ""))) {
      throw coded("summary_request_invalid");
    }
    return {
      ok: true,
      contract: SUMMARY_CONTRACT,
      inputDigest: request.inputDigest,
      summary: deterministicSummary(request.untrustedData),
      instructionsExecuted: false,
      sourceReferencesIncluded: false,
      privateSourceNamed: false,
    };
  }

  async pollActiveSENNotifications() {
    throw coded("sen_adapter_unavailable");
  }

  async sendReviewedIMessage(request) {
    this._verifySendRequest(request);
    this._verifyIMessageOnlyTransport();
    this._verifyRecipientPolicy();
    this._verifyLiveGuard();
    const result = this._command(this.openclawPath, [
      "message",
      "send",
      "--channel",
      "imessage",
      "--target",
      `imessage:${request.recipient.principal.handle}`,
      "--message",
      request.text,
      "--json",
    ], "imessage_send_failed");
    const decoded = parseOneJSON(result);
    const transportMessageId = findTransportMessageId(decoded);
    if (!transportMessageId) throw coded("delivery_ack_unavailable");
    return {
      ok: true,
      channel: "imessage",
      sourceAccount: this.grant.imessage.sourceAccount,
      recipient: this.grant.jeff,
      recipientGuardContract: RECIPIENT_GUARD_CONTRACT,
      guardDecisionId: sha256(`rico-guard\0${request.idempotencyKey}\0${transportMessageId}`),
      idempotencyKey: request.idempotencyKey,
      transportMessageId,
      deliveredAck: true,
      smsFallbackDisabled: true,
      rateLimitsEnforced: true,
    };
  }

  async enqueueResearchHandoff(request) {
    if (request?.contract !== RESEARCH_CONTRACT || request.internalOnly !== true
      || !/^[a-f0-9]{64}$/u.test(String(request.sourceRef ?? ""))
      || request.constraints?.rawConversationIncluded !== false
      || request.constraints?.maySendMessages !== false
      || request.constraints?.maySendEmail !== false
      || request.constraints?.mayReadOrExportCredentials !== false
      || request.constraints?.mayChangeSecurity !== false
      || request.constraints?.mayChangeConfiguration !== false
      || request.constraints?.mayScheduleActions !== false) {
      throw coded("research_request_invalid");
    }
    const handoffId = `ists-research-${sha256(canonicalJson({
      sourceRef: request.sourceRef,
      question: request.researchQuestion,
    })).slice(0, 32)}`;
    appendPrivateJSONL(path.join(this.stateDirectory, "research-handoffs.jsonl"), {
      schema: "rico.ists-research-ledger-entry",
      schemaVersion: 1,
      handoffId,
      sourceRef: request.sourceRef,
      researchQuestion: request.researchQuestion,
      allowedSources: request.allowedSources,
      allowedPublicCitationTypes: request.allowedPublicCitationTypes,
      optionalCollaborators: request.optionalCollaborators,
      internalOnly: true,
      outboundAuthority: false,
      createdAt: this.now().toISOString(),
    });
    return {
      ok: true,
      contract: RESEARCH_CONTRACT,
      sourceRef: request.sourceRef,
      handoffId,
      internalOnly: true,
      rawConversationDisclosed: false,
      outboundAuthority: false,
      credentialAuthority: false,
      securityAuthority: false,
      configurationAuthority: false,
      scheduledAuthority: false,
      domainContextAuthority: false,
    };
  }

  _command(executable, argv, code) {
    return this.run(executable, argv, { code });
  }

  _verifyGroupSnapshot() {
    const decoded = parseOneJSON(this._command(
      this.imsgPath,
      ["group", "--chat-id", String(this.chatRowId), "--json"],
      "incident_group_unavailable",
    ));
    const identity = extractGroupIdentity(decoded);
    if (identity.chatRowId !== this.chatRowId || identity.isGroup !== true) throw coded("incident_group_identity_mismatch");
    const participants = canonicalParticipants(identity.participants);
    const hash = participantSnapshotSha256(participants);
    if (hash !== this.grant.incidentChat.participantSnapshotSha256
      || this.grant.incidentChat.participantRevision !== `sha256:${hash}`) {
      throw coded("incident_group_membership_changed");
    }
  }

  _verifySourceAccount() {
    const decoded = parseJSONOutput(this._command(
      this.imsgPath,
      ["account", "--local", "--json"],
      "imessage_account_unavailable",
    ));
    const emails = new Set(collectAccountLogins(decoded));
    if (!emails.has(this.grant.imessage.sourceAccount)) throw coded("imessage_source_account_mismatch");
  }

  _verifyIMessageOnlyTransport() {
    // OpenClaw's supported `imessage:<handle>` target makes the service
    // explicit, so imsg never enters its `auto` phone-send fallback path. Keep
    // the channel-level default exact as a second, independently read-back
    // fail-closed invariant before both preflight and every reviewed send.
    const service = parseOneJSON(this._command(
      this.openclawPath,
      ["config", "get", "channels.imessage.service", "--json"],
      "imessage_service_unavailable",
    ));
    if (service !== "imessage") throw coded("imessage_only_service_required");
  }

  _verifyRecipientPolicy() {
    assertPrivateFile(this.guardPolicyPath, "recipient_guard_policy_unavailable");
    const policy = parseOneJSON(fs.readFileSync(this.guardPolicyPath, "utf8"));
    if (policy?.schemaVersion !== 2 || policy.paused !== false || !Array.isArray(policy.identities)) {
      throw coded("recipient_guard_policy_unavailable");
    }
    const owner = exactIndividual(policy.identities, this.grant.owner.principal.handle);
    const jeff = exactIndividual(policy.identities, this.grant.jeff.principal.handle);
    const group = policy.identities.filter((item) => normalizeTarget(item?.target) === this.grant.incidentChat.chatId);
    if (owner.length !== 1 || owner[0].access !== "owner") throw coded("recipient_guard_owner_scope_mismatch");
    if (jeff.length !== 1 || !new Set(["approved", "trusted"]).has(jeff[0].access)) {
      throw coded("recipient_guard_jeff_scope_mismatch");
    }
    if (group.length !== 1 || group[0].kind !== "group" || !new Set(["approved", "trusted"]).has(group[0].access)) {
      throw coded("recipient_guard_group_scope_mismatch");
    }
    const policyParticipants = canonicalParticipants((group[0].participants ?? []).map(principalFromHandle));
    if (participantSnapshotSha256(policyParticipants) !== this.grant.incidentChat.participantSnapshotSha256) {
      throw coded("recipient_guard_group_membership_mismatch");
    }
  }

  _verifyLiveGuard() {
    const decoded = parseOneJSON(this._command(
      this.openclawPath,
      ["gateway", "call", "rico.recipient.status", "--json", "--timeout", "10000"],
      "recipient_guard_status_unavailable",
    ));
    if (decoded?.healthy !== true || decoded?.paused !== false
      || decoded?.contractVersion !== RECIPIENT_GUARD_CONTRACT
      || decoded?.enforcement?.verified !== true || decoded?.enforcement?.authority !== "gateway") {
      throw coded("recipient_guard_unverified");
    }
  }

  _verifyReadRequest(request) {
    if (request?.contract !== ADAPTER_CONTRACT || request.chatId !== this.grant.incidentChat.chatId
      || request.participantRevision !== this.grant.incidentChat.participantRevision
      || request.participantSnapshotSha256 !== this.grant.incidentChat.participantSnapshotSha256
      || request.excludeAgentAuthored !== true || request.executeMessageInstructions !== false) {
      throw coded("incident_read_request_mismatch");
    }
    if (participantSnapshotSha256(request.participants) !== this.grant.incidentChat.participantSnapshotSha256) {
      throw coded("incident_read_participants_mismatch");
    }
    this._verifyGroupSnapshot();
  }

  _readMessages(limit) {
    const records = parseJSONOutput(this._command(
      this.imsgPath,
      ["history", "--chat-id", String(this.chatRowId), "--limit", String(limit), "--attachments", "--json"],
      "incident_history_unavailable",
    ));
    return extractMessageRows(records)
      .map((row) => normalizedInboundMessage(row, this.grant))
      .filter(Boolean)
      .sort((left, right) => Date.parse(left.sentAt) - Date.parse(right.sentAt));
  }

  _readProof(messages, nextCursor) {
    return {
      chatId: this.grant.incidentChat.chatId,
      participantRevision: this.grant.incidentChat.participantRevision,
      participants: this.grant.incidentChat.participants,
      participantSnapshotSha256: this.grant.incidentChat.participantSnapshotSha256,
      agentAuthoredExcluded: true,
      messages,
      nextCursor,
    };
  }

  _verifySendRequest(request) {
    if (request?.channel !== "imessage" || request.direction !== "outbound"
      || request.sourceAccount !== this.grant.imessage.sourceAccount
      || request.recipient?.profileId !== this.grant.jeff.profileId
      || !samePrincipal(request.recipient?.principal, this.grant.jeff.principal)
      || request.recipientGuard?.required !== true
      || request.recipientGuard?.contract !== RECIPIENT_GUARD_CONTRACT
      || request.recipientGuard?.exactDirectRecipientOnly !== true
      || request.recipientGuard?.allowGroupExpansion !== false
      || request.recipientGuard?.allowSmsFallback !== false
      || request.recipientGuard?.requireDeliveredAcknowledgement !== true
      || request.recipientGuard?.reuseExistingRateLimits !== true
      || !/^rico:ists:[a-f0-9]{64}$/u.test(String(request.idempotencyKey ?? ""))) {
      throw coded("reviewed_send_request_mismatch");
    }
  }
}

export function extractGroupIdentity(decoded) {
  const value = unwrapSingle(decoded);
  const chatRowId = positiveInteger(value?.chat_id ?? value?.chatId ?? value?.id ?? value?.rowid);
  const explicit = value?.is_group ?? value?.isGroup ?? value?.group;
  const participants = (value?.participants ?? value?.handles ?? value?.members ?? [])
    .map((item) => principalFromHandle(typeof item === "string" ? item : item?.handle ?? item?.address ?? item?.id));
  return {
    chatRowId,
    isGroup: explicit === true || explicit === 1 || explicit === "true" || participants.length > 1,
    participants,
  };
}

export function extractMessageRows(decoded) {
  const values = Array.isArray(decoded) ? decoded : [decoded];
  const output = [];
  for (const value of values) {
    if (Array.isArray(value?.messages)) output.push(...value.messages);
    else if (Array.isArray(value?.result?.messages)) output.push(...value.result.messages);
    else if (value && typeof value === "object" && !Array.isArray(value)) output.push(value);
  }
  return output;
}

export function normalizedInboundMessage(row, grantInput) {
  const grant = validatePermissionGrant(grantInput);
  if (typeof row?.is_from_me !== "boolean" && typeof row?.isFromMe !== "boolean") {
    throw coded("message_direction_unproven");
  }
  if ((row.is_from_me ?? row.isFromMe) === true) return null;
  const sender = principalFromHandle(row.sender ?? row.sender_id ?? row.senderId ?? row.handle);
  if (!grant.incidentChat.participants.some((item) => samePrincipal(item, sender))) {
    throw coded("message_sender_outside_snapshot");
  }
  const text = String(row.text ?? row.body ?? row.message ?? "").replace(/\u0000/gu, "").trim();
  const attachments = row.attachments ?? row.files ?? [];
  const hasAttachment = Array.isArray(attachments) && attachments.length > 0;
  if (!text && !hasAttachment) return null;
  const messageId = String(row.guid ?? row.message_id ?? row.messageId ?? row.id ?? row.rowid ?? "").trim();
  if (!messageId) throw coded("message_id_unavailable");
  const sentAt = new Date(row.created_at ?? row.createdAt ?? row.sent_at ?? row.sentAt ?? row.date ?? row.timestamp);
  if (!Number.isFinite(sentAt.getTime())) throw coded("message_timestamp_unavailable");
  return {
    messageId,
    sentAt: sentAt.toISOString(),
    sender,
    eventKind: text ? "text" : "attachment",
    text: text.slice(0, 12_000),
  };
}

export function deterministicSummary(untrustedData) {
  const service = Array.isArray(untrustedData?.activeServiceStatus) ? untrustedData.activeServiceStatus : [];
  const latestService = [...service].sort(byLatestUpdate).at(-1);
  if (latestService?.safeSummary) return safeFallbackFragment(latestService.safeSummary);
  const sen = Array.isArray(untrustedData?.activeSEN) ? untrustedData.activeSEN : [];
  const latestSEN = [...sen].sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt)).at(-1);
  if (latestSEN?.safeSummary) return safeFallbackFragment(latestSEN.safeSummary);
  const messages = Array.isArray(untrustedData?.messages) ? untrustedData.messages : [];
  const text = messages.map((item) => String(item?.text ?? "").toLowerCase()).join(" ");
  if (/\b(auth|login|sign[ -]?in|credential|sso|identity)\b/u.test(text)) return "authentication failures affecting production access";
  if (/\b(network|connect|dns|route|vpn|firewall)\b/u.test(text)) return "a production network connectivity degradation";
  if (/\b(latency|slow|delay|timeout|performance)\b/u.test(text)) return "elevated latency affecting a production service";
  if (/\b(outage|down|unavailable|offline|failure|error)\b/u.test(text)) return "a production service availability degradation";
  return "an active production service degradation under review";
}

function safeFallbackFragment(value) {
  let text = String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  text = text.replace(/[.!?]+$/u, "").replace(/["“”<>`{}]/gu, "");
  if (!text || text.length > 240 || /https?:\/\/|\b[^\s@]+@[^\s@]+\.[^\s@]+\b|\+[1-9]\d{7,14}/iu.test(text)) {
    return "an active production service degradation under review";
  }
  return text;
}

function requireExactBinding(actual, expected, code) {
  if (!actual || actual.chatId !== expected.chatId || actual.participantRevision !== expected.participantRevision
    || actual.participantSnapshotSha256 !== expected.participantSnapshotSha256
    || participantSnapshotSha256(actual.participants) !== expected.participantSnapshotSha256) throw coded(code);
}

function requireExactPerson(actual, expected, code) {
  if (!actual || actual.profileId !== expected.profileId || !samePrincipal(actual.principal, expected.principal)) throw coded(code);
}

function exactIndividual(identities, handle) {
  const target = normalizeTarget(handle);
  return identities.filter((item) => item?.kind === "individual" && normalizeTarget(item?.target) === target);
}

function normalizeTarget(value) {
  const raw = String(value ?? "").trim();
  const lower = raw.toLowerCase();
  if (/^chat_(?:id|guid|identifier):/u.test(lower)) {
    const index = raw.indexOf(":");
    return `${lower.slice(0, index)}:${raw.slice(index + 1)}`;
  }
  if (lower.startsWith("imessage:") || lower.startsWith("sms:") || lower.startsWith("tel:") || lower.startsWith("mailto:")) {
    return normalizeTarget(raw.slice(raw.indexOf(":") + 1));
  }
  if (raw.includes("@")) return lower;
  const digits = raw.replace(/\D/gu, "");
  if (raw.startsWith("+")) return digits ? `+${digits}` : "";
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
}

function principalFromHandle(value) {
  const target = normalizeTarget(value);
  if (!target || target.startsWith("chat_")) throw coded("participant_principal_invalid");
  return normalizePrincipal({ kind: target.includes("@") ? "email" : "phone", handle: target });
}

function parseJSONOutput(output) {
  const text = String(output ?? "").trim();
  if (!text) return [];
  try { return JSON.parse(text); } catch {
    return text.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  }
}

function parseOneJSON(output) {
  const parsed = parseJSONOutput(output);
  if (Array.isArray(parsed) && parsed.length === 1) return parsed[0];
  return parsed;
}

function unwrapSingle(value) {
  if (Array.isArray(value) && value.length === 1) return unwrapSingle(value[0]);
  return value?.result && typeof value.result === "object" ? unwrapSingle(value.result) : value;
}

function collectAccountLogins(value, output = []) {
  if (Array.isArray(value)) value.forEach((item) => collectAccountLogins(item, output));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (new Set(["login", "account_login", "accountLogin"]).has(key) && typeof item === "string") {
        const email = normalizeAccountLogin(item);
        if (email) output.push(email);
      } else if (item && typeof item === "object") collectAccountLogins(item, output);
    }
  }
  return output;
}

function findTransportMessageId(value) {
  if (!value || typeof value !== "object") return "";
  for (const key of ["messageId", "message_id", "transportMessageId", "guid", "id"]) {
    const candidate = value[key];
    if ((typeof candidate === "string" || typeof candidate === "number") && String(candidate).trim()) return String(candidate).trim();
  }
  for (const child of Object.values(value)) {
    const found = findTransportMessageId(child);
    if (found) return found;
  }
  return "";
}

function cursorFor(messages) {
  return sha256(canonicalJson(messages.map((item) => [item.messageId, item.sentAt])));
}

function byLatestUpdate(left, right) {
  return Date.parse(left?.updatedAt ?? left?.startedAt ?? 0) - Date.parse(right?.updatedAt ?? right?.startedAt ?? 0);
}

function exactChatRowId(value) {
  const match = /^chat_id:([1-9]\d*)$/u.exec(String(value ?? ""));
  if (!match) throw coded("incident_chat_row_id_required");
  return positiveInteger(match[1]);
}

function positiveInteger(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw coded("positive_integer_required");
  return number;
}

function normalizeEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ? email : "";
}

function normalizeAccountLogin(value) {
  const raw = String(value ?? "").trim();
  // imsg 0.14 identifies email-backed Messages accounts with exactly `E:`.
  // Decode only that reviewed transport marker; arbitrary prefixes remain an
  // account mismatch instead of becoming an alternate identity syntax.
  if (raw.startsWith("E:")) return normalizeEmail(raw.slice(2));
  if (/^[A-Za-z][A-Za-z0-9_-]{0,15}:/u.test(raw)) return "";
  return normalizeEmail(raw);
}

function samePrincipal(left, right) {
  try {
    const a = normalizePrincipal(left, "left principal");
    const b = normalizePrincipal(right, "right principal");
    return a.kind === b.kind && a.handle === b.handle;
  } catch {
    return false;
  }
}

function defaultGuardPolicyPath(homeDirectory = os.homedir()) {
  return path.join(homeDirectory, "Library", "Application Support", "OpenClaw Studio", "rico-recipient-guard.json");
}

function privateExecutable(value, code) {
  const resolved = path.resolve(String(value ?? ""));
  let stat;
  try { stat = fs.lstatSync(resolved); } catch { throw coded(code); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) throw coded(code);
  return resolved;
}

function assertPrivateFile(filePath, code) {
  let stat;
  try { stat = fs.lstatSync(filePath); } catch { throw coded(code); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw coded(code);
}

function appendPrivateJSONL(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  if (fs.existsSync(filePath)) assertPrivateFile(filePath, "research_ledger_not_private");
  const descriptor = fs.openSync(filePath, "a", 0o600);
  try {
    fs.writeSync(descriptor, `${JSON.stringify(value)}\n`, null, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(filePath, 0o600);
}

function runCommand(executable, argv, { code = "command_failed" } = {}) {
  const result = spawnSync(executable, argv, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
    env: { ...process.env, PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" },
  });
  if (result.error || result.status !== 0) throw coded(code);
  return String(result.stdout ?? "").trim();
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
