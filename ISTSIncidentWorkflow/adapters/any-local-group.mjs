import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveIMsgExecutable } from "../imsg-executable.mjs";
import {
  ANY_GROUP_ADAPTER_CONTRACT,
  ANY_GROUP_GLOBAL_LIMIT,
  ANY_GROUP_PER_GROUP_LIMIT,
  ANY_GROUP_RATE_WINDOW_MS,
  ANY_GROUP_RECIPIENT_GUARD_EXCLUSION_CONTRACT,
  ANY_GROUP_SEND_CONTRACT,
  anyGroupRecipientGuardExclusionRequest,
  canonicalLiveParticipants,
  liveParticipantSnapshotSha256,
  validateAnyGroupSendRequest,
} from "../any-group-contracts.mjs";
import {
  assertPrivateFile,
  canonicalJson,
  ensurePrivateDirectory,
  normalizePrincipal,
  sha256,
  validatePermissionGrant,
  writePrivateJson,
} from "../grant.mjs";

const DEFAULT_RECIPIENT_GUARD_POLICY = path.join(
  os.homedir(), "Library", "Application Support", "OpenClaw Studio", "rico-recipient-guard.json",
);
const DELIVERY_SCHEMA = "rico.ists-any-group-delivery-ledger";

export async function createISTSAnyLocalGroupAdapter(context) {
  return new LocalISTSAnyGroupAdapter(context);
}

export class LocalISTSAnyGroupAdapter {
  constructor({
    permissionGrant,
    stateDirectory,
    imsgPath = undefined,
    recipientGuardPolicyPath = DEFAULT_RECIPIENT_GUARD_POLICY,
    run = runCommand,
    now = () => new Date(),
  }) {
    this.grant = validatePermissionGrant(permissionGrant);
    if (this.grant.schemaVersion !== 2 || this.grant.imessage.anyLocalGroup !== true) {
      throw coded("any_local_group_not_authorized");
    }
    this.stateDirectory = ensurePrivateDirectory(path.resolve(stateDirectory));
    this.deliveryLedgerPath = path.join(this.stateDirectory, "any-group-delivery-ledger.json");
    this.imsgPath = resolveIMsgExecutable(imsgPath);
    this.recipientGuardPolicyPath = exactAbsolutePath(recipientGuardPolicyPath, "recipient_guard_policy_path_invalid");
    this.run = run;
    this.now = now;
  }

  async preflightAnyLocalGroups(request) {
    exactKeys(request, ["contract", "sourceAccount", "anyLocalGroup", "requiredCapabilities"], "any group preflight request");
    if (request.contract !== ANY_GROUP_ADAPTER_CONTRACT
      || normalizeEmail(request.sourceAccount) !== this.grant.imessage.sourceAccount
      || request.anyLocalGroup !== true || !Array.isArray(request.requiredCapabilities)) {
      throw coded("any_group_preflight_request_mismatch");
    }
    this._verifySourceAccount();
    return {
      ok: true,
      contract: ANY_GROUP_ADAPTER_CONTRACT,
      sourceAccount: this.grant.imessage.sourceAccount,
      exactLocalSourceAccount: true,
      readOnlyDiscovery: true,
      liveMembershipRequired: true,
      ownerMembershipRequired: true,
      recipientGuardExclusionRequired: true,
      fromMeExcluded: true,
      sameGroupOnly: true,
      noSmsFallback: true,
      deliveredAcknowledgement: true,
      durableIdempotency: true,
      globalRateLimit: ANY_GROUP_GLOBAL_LIMIT,
      perGroupRateLimit: ANY_GROUP_PER_GROUP_LIMIT,
      rateWindowMilliseconds: ANY_GROUP_RATE_WINDOW_MS,
      generalRicoPolicyBroadened: false,
      nativeAllowlistBroadened: false,
      modelOrToolExecutionAllowed: false,
    };
  }

  async listLocalIMessageGroups(request) {
    exactKeys(request, [
      "contract", "sourceAccount", "anyLocalGroup", "channel", "groupOnly", "readOnly", "maxGroups",
    ], "any group list request");
    if (request.contract !== ANY_GROUP_ADAPTER_CONTRACT || request.anyLocalGroup !== true
      || request.channel !== "imessage" || request.groupOnly !== true || request.readOnly !== true
      || request.maxGroups !== 10_000 || normalizeEmail(request.sourceAccount) !== this.grant.imessage.sourceAccount) {
      throw coded("any_group_list_request_mismatch");
    }
    this._verifySourceAccount();
    const records = parseJSONOutput(this._command([
      "chats", "--limit", String(request.maxGroups), "--json",
    ], "any_group_list_unavailable"));
    const groups = records
      .filter((row) => explicitTrue(row?.is_group ?? row?.isGroup))
      .filter((row) => String(row?.service ?? "").toLowerCase() === "imessage")
      .filter((row) => normalizeAccountLogin(row?.account_login ?? row?.accountLogin) === this.grant.imessage.sourceAccount)
      .filter((row) => rowContainsPrincipal(row, this.grant.owner.principal))
      .map((row) => discoveredGroup(row));
    return {
      contract: ANY_GROUP_ADAPTER_CONTRACT,
      sourceAccount: this.grant.imessage.sourceAccount,
      exactLocalSourceAccount: true,
      readOnly: true,
      groups,
    };
  }

  async readLocalGroupMessages(request) {
    exactKeys(request, [
      "contract", "sourceAccount", "chatRowId", "chatGuid", "discoveryParticipantSnapshotSha256",
      "afterAt", "maxItems", "readOnly", "excludeFromMe", "executeMessageInstructions", "attachments",
    ], "any group read request");
    if (request.contract !== ANY_GROUP_ADAPTER_CONTRACT || normalizeEmail(request.sourceAccount) !== this.grant.imessage.sourceAccount
      || request.readOnly !== true || request.excludeFromMe !== true || request.executeMessageInstructions !== false
      || request.attachments !== false || !Number.isInteger(request.maxItems) || request.maxItems < 1 || request.maxItems > 100
      || !/^[a-f0-9]{64}$/u.test(String(request.discoveryParticipantSnapshotSha256 ?? ""))) {
      throw coded("any_group_read_request_mismatch");
    }
    this._verifySourceAccount();
    const group = this._liveGroup(request.chatRowId, request.chatGuid);
    const argv = ["history", "--chat-id", String(group.chatRowId), "--limit", String(request.maxItems), "--json"];
    if (request.afterAt !== null) argv.push("--start", iso(request.afterAt, "any_group_read_cursor_invalid"));
    const rows = parseJSONOutput(this._command(argv, "any_group_history_unavailable"));
    const messages = rows.map((row) => inboundMessage(row, group)).filter(Boolean)
      .sort((left, right) => Date.parse(left.sentAt) - Date.parse(right.sentAt));
    return {
      contract: ANY_GROUP_ADAPTER_CONTRACT,
      sourceAccount: this.grant.imessage.sourceAccount,
      readOnly: true,
      group,
      agentAuthoredExcluded: true,
      messages,
    };
  }

  async proveRecipientGuardExclusion(input) {
    const request = anyGroupRecipientGuardExclusionRequest(this.grant, input);
    if (canonicalJson(input) !== canonicalJson(request)) throw coded("any_group_recipient_guard_check_mismatch");
    this._verifySourceAccount();
    const live = this._liveGroup(request.group.chatRowId, request.group.chatGuid);
    if (live.participantSnapshotSha256 !== request.group.participantSnapshotSha256
      || !live.participants.some((item) => samePrincipal(item, request.sender))) {
      throw coded("any_group_membership_changed_before_exclusion_check");
    }
    const policy = this._readRecipientGuardPolicy();
    assertRecipientGuardSenderNotBlocked(policy, request.sender);
    const recipientGuard = recipientGuardLiveGroupStatus(policy, live);
    return {
      contract: ANY_GROUP_RECIPIENT_GUARD_EXCLUSION_CONTRACT,
      sourceAccount: this.grant.imessage.sourceAccount,
      chatRowId: live.chatRowId,
      chatGuid: live.chatGuid,
      participantSnapshotSha256: live.participantSnapshotSha256,
      sender: request.sender,
      policySnapshotSha256: sha256(canonicalJson(policy)),
      recipientGuardPaused: recipientGuard.paused,
      recipientGuardManaged: recipientGuard.managed,
      recipientGuardAdmitted: recipientGuard.admitted,
      readOnly: true,
      exactPolicyAndMembership: true,
    };
  }

  async sendSameGroupIncidentReply(input) {
    const request = validateAnyGroupSendRequest(input, this.grant, { now: this.now() });
    this._verifySourceAccount();
    const live = this._liveGroup(request.group.chatRowId, request.group.chatGuid);
    if (live.participantSnapshotSha256 !== request.group.participantSnapshotSha256
      || !live.participants.some((item) => samePrincipal(item, request.sender))) {
      throw coded("any_group_membership_changed_before_send");
    }
    const policy = this._readRecipientGuardPolicy();
    assertRecipientGuardSenderNotBlocked(policy, request.sender);
    const recipientGuard = recipientGuardLiveGroupStatus(policy, live);
    if (recipientGuard.paused) throw coded("any_group_recipient_guard_paused");
    if (recipientGuard.managed) throw coded("any_group_recipient_guard_managed");
    const groupKey = sha256(`any-group\0${live.accountLogin}\0${live.chatGuid}`);
    const ledger = this._readDeliveryLedger();
    if (ledger.entries.some((entry) => entry.idempotencyKey === request.idempotencyKey)) {
      throw coded("any_group_delivery_already_reserved");
    }
    this._enforceRateLimits(ledger, groupKey);
    const reservation = {
      idempotencyKey: request.idempotencyKey,
      payloadHash: request.payloadHash,
      groupKey,
      state: "reserved",
      reservedAt: this.now().toISOString(),
      completedAt: null,
      acknowledgementHash: null,
      errorCode: null,
    };
    ledger.entries.push(reservation);
    this._writeDeliveryLedger(ledger);
    try {
      const output = this._command([
        "send",
        "--chat-id", String(live.chatRowId),
        "--text", request.text,
        "--service", "imessage",
        "--no-sms-fallback",
        "--json",
      ], "any_group_send_failed");
      const transportMessageId = findTransportMessageId(parseJSONOutput(output));
      if (!transportMessageId) throw coded("any_group_delivery_ack_unavailable");
      reservation.state = "delivered";
      reservation.completedAt = this.now().toISOString();
      reservation.acknowledgementHash = sha256(transportMessageId);
      this._writeDeliveryLedger(ledger);
      return {
        ok: true,
        contract: ANY_GROUP_SEND_CONTRACT,
        sourceAccount: this.grant.imessage.sourceAccount,
        chatRowId: live.chatRowId,
        chatGuid: live.chatGuid,
        participantSnapshotSha256: live.participantSnapshotSha256,
        idempotencyKey: request.idempotencyKey,
        transportMessageId,
        deliveredAcknowledgement: true,
        sameExactGroup: true,
        noSmsFallback: true,
        globalRateLimitEnforced: true,
        perGroupRateLimitEnforced: true,
      };
    } catch (error) {
      reservation.state = "outcome-unknown";
      reservation.completedAt = this.now().toISOString();
      reservation.errorCode = safeCode(error);
      this._writeDeliveryLedger(ledger);
      throw error;
    }
  }

  _verifySourceAccount() {
    const records = parseJSONOutput(this._command(["account", "--local", "--json"], "imessage_account_unavailable"));
    const logins = new Set(collectAccountLogins(records));
    if (!logins.has(this.grant.imessage.sourceAccount)) throw coded("imessage_source_account_mismatch");
  }

  _liveGroup(chatRowId, expectedGuid) {
    const id = positiveInteger(chatRowId, "any_group_chat_id_invalid");
    const decoded = unwrapSingle(parseJSONOutput(this._command([
      "group", "--chat-id", String(id), "--json",
    ], "any_group_identity_unavailable")));
    const group = liveGroup(decoded);
    if (group.chatRowId !== id || group.chatGuid !== expectedGuid
      || group.accountLogin !== this.grant.imessage.sourceAccount
      || !group.participants.some((item) => samePrincipal(item, this.grant.owner.principal))) {
      throw coded("any_group_identity_mismatch");
    }
    return group;
  }

  _enforceRateLimits(ledger, groupKey) {
    const cutoff = this.now().getTime() - ANY_GROUP_RATE_WINDOW_MS;
    const recent = ledger.entries.filter((entry) => Date.parse(entry.reservedAt) > cutoff);
    if (recent.length >= ANY_GROUP_GLOBAL_LIMIT) throw coded("any_group_global_rate_limited");
    if (recent.filter((entry) => entry.groupKey === groupKey).length >= ANY_GROUP_PER_GROUP_LIMIT) {
      throw coded("any_group_per_group_rate_limited");
    }
  }

  _readDeliveryLedger() {
    if (!fs.existsSync(this.deliveryLedgerPath)) return { schema: DELIVERY_SCHEMA, schemaVersion: 1, entries: [] };
    assertPrivateFile(this.deliveryLedgerPath);
    const value = JSON.parse(fs.readFileSync(this.deliveryLedgerPath, "utf8"));
    exactKeys(value, ["schema", "schemaVersion", "entries"], "any group delivery ledger");
    if (value.schema !== DELIVERY_SCHEMA || value.schemaVersion !== 1 || !Array.isArray(value.entries)
      || value.entries.length > 10_000) throw coded("any_group_delivery_ledger_invalid");
    value.entries.forEach(validateDeliveryEntry);
    return value;
  }

  _readRecipientGuardPolicy() {
    const parent = path.dirname(this.recipientGuardPolicyPath);
    const parentStat = fs.lstatSync(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (parentStat.mode & 0o777) !== 0o700
      || (typeof process.getuid === "function" && parentStat.uid !== process.getuid())
      || fs.realpathSync(parent) !== parent) throw coded("recipient_guard_policy_directory_unsafe");
    assertPrivateFile(this.recipientGuardPolicyPath);
    if (fs.realpathSync(this.recipientGuardPolicyPath) !== this.recipientGuardPolicyPath) {
      throw coded("recipient_guard_policy_path_unsafe");
    }
    const policy = JSON.parse(fs.readFileSync(this.recipientGuardPolicyPath, "utf8"));
    validateRecipientGuardPolicy(policy);
    return policy;
  }

  _writeDeliveryLedger(ledger) {
    ledger.entries = ledger.entries.slice(-10_000);
    writePrivateJson(this.deliveryLedgerPath, ledger);
  }

  _command(argv, code) {
    return this.run(this.imsgPath, argv, { code });
  }
}

export function discoveredGroup(row) {
  const participants = canonicalLiveParticipants((row?.participants ?? []).map(principalFromHandle));
  return {
    chatRowId: positiveInteger(row?.id ?? row?.chat_id ?? row?.chatId, "discovered_group_chat_id_invalid"),
    chatGuid: bounded(row?.guid, 1, 4_096, "discovered_group_guid_invalid"),
    accountLogin: requiredEmail(row?.account_login ?? row?.accountLogin, "discovered_group_account_invalid"),
    service: exactIMessage(row?.service),
    isGroup: requireTrue(row?.is_group ?? row?.isGroup, "discovered_group_not_group"),
    participantSnapshotSha256: liveParticipantSnapshotSha256(participants),
    lastMessageAt: row?.last_message_at === null || row?.lastMessageAt === null
      ? null
      : iso(row?.last_message_at ?? row?.lastMessageAt, "discovered_group_last_message_invalid"),
  };
}

export function liveGroup(row) {
  const participants = canonicalLiveParticipants((row?.participants ?? row?.handles ?? []).map((item) => (
    principalFromHandle(typeof item === "string" ? item : item?.handle ?? item?.address ?? item?.id)
  )));
  return {
    chatRowId: positiveInteger(row?.id ?? row?.chat_id ?? row?.chatId, "live_group_chat_id_invalid"),
    chatGuid: bounded(row?.guid, 1, 4_096, "live_group_guid_invalid"),
    accountLogin: requiredEmail(row?.account_login ?? row?.accountLogin, "live_group_account_invalid"),
    service: exactIMessage(row?.service),
    isGroup: requireTrue(row?.is_group ?? row?.isGroup, "live_group_not_group"),
    participants,
    participantSnapshotSha256: liveParticipantSnapshotSha256(participants),
  };
}

export function inboundMessage(row, group) {
  const direction = row?.is_from_me ?? row?.isFromMe;
  if (typeof direction !== "boolean") throw coded("any_group_message_direction_unproven");
  if (direction) return null;
  const sender = principalFromHandle(row?.sender ?? row?.sender_id ?? row?.senderId ?? row?.handle);
  if (!group.participants.some((item) => samePrincipal(item, sender))) throw coded("any_group_sender_not_live");
  const text = String(row?.text ?? row?.body ?? row?.message ?? "").normalize("NFKC").replace(/\u0000/gu, "");
  if (!text.trim()) return null;
  if (text.length > 2_000) throw coded("any_group_message_text_too_long");
  const messageId = bounded(row?.guid ?? row?.message_id ?? row?.messageId ?? row?.id ?? row?.rowid, 1, 4_096, "any_group_message_id_invalid");
  const sentAt = iso(row?.created_at ?? row?.createdAt ?? row?.sent_at ?? row?.sentAt ?? row?.date ?? row?.timestamp, "any_group_message_time_invalid");
  return { messageId, sentAt, sender, text, fromMe: false };
}

function validateDeliveryEntry(entry) {
  exactKeys(entry, [
    "idempotencyKey", "payloadHash", "groupKey", "state", "reservedAt", "completedAt",
    "acknowledgementHash", "errorCode",
  ], "any group delivery entry");
  if (!/^rico:ists:any-group:[a-f0-9]{64}$/u.test(String(entry.idempotencyKey ?? ""))
    || !/^[a-f0-9]{64}$/u.test(String(entry.payloadHash ?? ""))
    || !/^[a-f0-9]{64}$/u.test(String(entry.groupKey ?? ""))
    || !new Set(["reserved", "delivered", "outcome-unknown"]).has(entry.state)) {
    throw coded("any_group_delivery_entry_invalid");
  }
  iso(entry.reservedAt, "any_group_delivery_reserved_at_invalid");
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
  const queue = Array.isArray(value) ? [...value] : [value];
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item || typeof item !== "object") continue;
    for (const key of ["message_id", "messageId", "guid", "transportMessageId", "id"]) {
      const candidate = String(item[key] ?? "").trim();
      if (candidate) return candidate.slice(0, 4_096);
    }
    queue.push(...Object.values(item).filter((child) => child && typeof child === "object"));
  }
  return null;
}

function parseJSONOutput(output) {
  const text = String(output ?? "").trim();
  if (!text) return [];
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [value];
  } catch {
    return text.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  }
}

function unwrapSingle(value) {
  if (Array.isArray(value) && value.length === 1) return unwrapSingle(value[0]);
  return value?.result && typeof value.result === "object" ? unwrapSingle(value.result) : value;
}

function principalFromHandle(value) {
  const text = String(value ?? "").trim();
  if (text.includes("@")) return normalizePrincipal({ kind: "email", handle: text }, "any group participant");
  const digits = text.replace(/\D/gu, "");
  const handle = text.startsWith("+") ? `+${digits}` : digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith("1") ? `+${digits}` : "";
  return normalizePrincipal({ kind: "phone", handle }, "any group participant");
}

function samePrincipal(left, right) {
  return left?.kind === right?.kind && left?.handle === right?.handle;
}

function assertRecipientGuardSenderNotBlocked(policy, sender) {
  const exactSender = normalizePrincipal(sender, "any group recipient guard sender");
  const matches = policy.identities.filter((identity) => identity.kind === "individual"
    && samePrincipal(principalFromHandle(identity.target), exactSender));
  if (matches.some((identity) => identity.access === "blocked")) {
    throw coded("any_group_recipient_guard_sender_blocked");
  }
}

export function recipientGuardLiveGroupStatus(policy, live) {
  const targets = new Set([`chat_id:${live.chatRowId}`, `chat_guid:${live.chatGuid}`].map(normalizeGroupTarget));
  const matches = policy.identities.filter((identity) => identity.kind === "group"
    && targets.has(normalizeGroupTarget(identity.target)));
  if (matches.length > 1) throw coded("recipient_guard_group_policy_ambiguous");
  if (matches.length === 0) {
    return Object.freeze({ paused: policy.paused === true, managed: false, admitted: false });
  }
  const identity = matches[0];
  const expected = canonicalPrincipalHandles(identity.participants);
  const actual = canonicalPrincipalHandles(live.participants.map((item) => item.handle));
  const exactMembership = expected.length === actual.length
    && expected.every((value, index) => value === actual[index]);
  return Object.freeze({
    paused: policy.paused === true,
    managed: true,
    admitted: policy.paused !== true && identity.access !== "blocked"
      && identity.autoReply === true && exactMembership,
  });
}

function validateRecipientGuardPolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy) || policy.schemaVersion !== 2
    || typeof policy.paused !== "boolean" || !Array.isArray(policy.identities)
    || policy.identities.length > 10_000) throw coded("recipient_guard_policy_invalid");
  for (const identity of policy.identities) {
    if (!identity || typeof identity !== "object" || Array.isArray(identity)
      || !new Set(["individual", "group"]).has(identity.kind)
      || !new Set(["blocked", "approved", "trusted", "owner"]).has(identity.access)
      || typeof identity.autoReply !== "boolean" || typeof identity.requireMention !== "boolean") {
      throw coded("recipient_guard_policy_invalid");
    }
    if (identity.kind === "group") {
      if (!/^chat_(?:id|guid|identifier):.+$/iu.test(normalizeGroupTarget(identity.target))
        || !Array.isArray(identity.participants) || identity.participants.length < 1
        || identity.participants.length > 100) throw coded("recipient_guard_policy_invalid");
      canonicalPrincipalHandles(identity.participants);
    }
  }
  return policy;
}

function canonicalPrincipalHandles(values) {
  const normalized = values.map((value) => principalFromHandle(
    typeof value === "string" ? value : value?.handle ?? value?.address ?? value?.id,
  )).map((item) => `${item.kind}:${item.handle}`).sort();
  if (new Set(normalized).size !== normalized.length) throw coded("recipient_guard_policy_invalid");
  return normalized;
}

function normalizeGroupTarget(value) {
  const raw = String(value ?? "").trim();
  const separator = raw.indexOf(":");
  if (separator < 1) return "";
  const prefix = raw.slice(0, separator).toLowerCase();
  const suffix = raw.slice(separator + 1).trim();
  return /^chat_(?:id|guid|identifier)$/u.test(prefix) && suffix ? `${prefix}:${suffix}` : "";
}

function rowContainsPrincipal(row, principal) {
  try {
    return (row?.participants ?? row?.handles ?? []).some((item) => samePrincipal(
      principalFromHandle(typeof item === "string" ? item : item?.handle ?? item?.address ?? item?.id),
      principal,
    ));
  } catch {
    return false;
  }
}

function explicitTrue(value) {
  return value === true || value === 1;
}

function requireTrue(value, code) {
  if (!explicitTrue(value)) throw coded(code);
  return true;
}

function exactIMessage(value) {
  if (String(value ?? "").toLowerCase() !== "imessage") throw coded("any_group_service_not_imessage");
  return "iMessage";
}

function requiredEmail(value, code) {
  const email = normalizeAccountLogin(value);
  if (!email) throw coded(code);
  return email;
}

function normalizeEmail(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(text) ? text : "";
}

function normalizeAccountLogin(value) {
  const raw = String(value ?? "").trim();
  if (raw.startsWith("E:")) return normalizeEmail(raw.slice(2));
  if (/^[A-Za-z][A-Za-z0-9_-]{0,15}:/u.test(raw)) return "";
  return normalizeEmail(raw);
}

function positiveInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw coded(code);
  return number;
}

function exactAbsolutePath(value, code) {
  const text = String(value ?? "");
  if (!path.isAbsolute(text) || path.resolve(text) !== text) throw coded(code);
  return text;
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

function runCommand(executablePath, argv, { code }) {
  const result = spawnSync(executablePath, argv, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" },
  });
  if (result.error || result.status !== 0) throw coded(code);
  return String(result.stdout ?? "");
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

function safeCode(error) {
  return String(error?.code ?? error?.name ?? "unknown").toLowerCase().replace(/[^a-z0-9_-]+/gu, "_").slice(0, 80) || "unknown";
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
