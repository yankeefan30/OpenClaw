import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  COLLEAGUE_ZONE_SOURCE_ID,
  COLLEAGUE_ZONE_URL,
  RECIPIENT_GUARD_CONTRACT,
} from "./definition.mjs";

const GRANT_SCHEMA = "rico.ists-incident-grant";

export function defaultStateDirectory(homeDirectory = os.homedir()) {
  return path.join(
    path.resolve(homeDirectory),
    "Library",
    "Application Support",
    "OpenClaw Studio",
    "workflows",
    "ists-incident",
  );
}

export function defaultGrantPath(homeDirectory = os.homedir()) {
  return path.join(defaultStateDirectory(homeDirectory), "permission-grant.json");
}

export function normalizePrincipal(input, label = "principal") {
  exactKeys(input, ["kind", "handle"], label);
  const kind = String(input.kind ?? "").trim();
  const raw = String(input.handle ?? "").trim();
  if (kind === "phone") {
    if (!/^\+[1-9]\d{7,14}$/u.test(raw)) throw coded(`${slug(label)}_phone_invalid`);
    return Object.freeze({ kind, handle: raw });
  }
  if (kind === "email") {
    const handle = raw.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(handle) || handle.length > 254) {
      throw coded(`${slug(label)}_email_invalid`);
    }
    return Object.freeze({ kind, handle });
  }
  throw coded(`${slug(label)}_kind_invalid`);
}

export function canonicalParticipants(participants) {
  if (!Array.isArray(participants) || participants.length < 2 || participants.length > 100) {
    throw coded("participant_snapshot_size_invalid");
  }
  const normalized = participants.map((item, index) => normalizePrincipal(item, `participant_${index}`));
  normalized.sort((left, right) => `${left.kind}:${left.handle}`.localeCompare(`${right.kind}:${right.handle}`));
  const keys = normalized.map((item) => `${item.kind}:${item.handle}`);
  if (new Set(keys).size !== keys.length) throw coded("participant_snapshot_duplicate");
  return Object.freeze(normalized);
}

export function participantSnapshotSha256(participants) {
  return sha256(canonicalJson(canonicalParticipants(participants)));
}

export function validatePermissionGrant(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw coded("permission_grant_invalid");
  const schemaVersion = Number(input.schemaVersion);
  const rootKeys = [
    "schema",
    "schemaVersion",
    "issuedAt",
    "incidentChat",
    ...(schemaVersion === 2 ? ["owner"] : []),
    ...(schemaVersion === 2 ? ["incidentQueryGroups"] : []),
    "jeff",
    "imessage",
    "monitor",
    "sen",
    "colleagueZone",
    "research",
  ];
  exactKeys(input, rootKeys, "permission grant");
  if (input.schema !== GRANT_SCHEMA || !new Set([1, 2]).has(schemaVersion)) throw coded("grant_schema_unsupported");
  const issuedAt = isoDate(input.issuedAt, "issued_at_invalid");

  exactKeys(input.incidentChat, ["chatId", "participantRevision", "participants", "participantSnapshotSha256"], "incident chat");
  const chatId = bounded(input.incidentChat.chatId, 1, 512, "chat_id_invalid");
  const participantRevision = bounded(input.incidentChat.participantRevision, 1, 256, "participant_revision_invalid");
  const participants = canonicalParticipants(input.incidentChat.participants);
  const snapshotHash = participantSnapshotSha256(participants);
  if (input.incidentChat.participantSnapshotSha256 !== snapshotHash) throw coded("participant_snapshot_hash_mismatch");

  const owner = schemaVersion === 2 ? validateScopedPerson(input.owner, "owner") : null;
  const jeff = validateScopedPerson(input.jeff, "jeff");

  exactKeys(
    input.imessage,
    schemaVersion === 2
      ? ["sourceAccount", "recipientGuardContract", "anyLocalGroup"]
      : ["sourceAccount", "recipientGuardContract"],
    "imessage",
  );
  const sourceAccount = email(input.imessage.sourceAccount, "imessage_source_invalid");
  if (input.imessage.recipientGuardContract !== RECIPIENT_GUARD_CONTRACT) throw coded("recipient_guard_contract_invalid");
  const anyLocalGroup = schemaVersion === 2
    ? requiredBoolean(input.imessage.anyLocalGroup, "imessage_any_local_group_invalid")
    : false;
  const incidentQueryGroups = schemaVersion === 2
    ? validateIncidentQueryGroups(input.incidentQueryGroups, owner, { allowEmpty: anyLocalGroup })
    : null;
  if (schemaVersion === 2) {
    if (samePrincipal(owner.principal, jeff.principal)) throw coded("owner_jeff_principal_collision");
    if (!participants.some((item) => samePrincipal(item, jeff.principal))) {
      throw coded("jeff_outside_incident_chat_snapshot");
    }
    if (participantRevision !== `sha256:${snapshotHash}`) {
      throw coded("participant_revision_not_snapshot_bound");
    }
  }

  exactKeys(input.monitor, ["sameIncidentCooldownSeconds"], "monitor");
  const cooldown = Number(input.monitor.sameIncidentCooldownSeconds);
  if (!Number.isInteger(cooldown) || cooldown < 180 || cooldown > 86_400) throw coded("same_incident_cooldown_invalid");

  const sen = validateSEN(input.sen);
  const colleagueZone = validateColleagueZone(input.colleagueZone);
  const research = validateResearch(input.research);
  return deepFreeze({
    schema: GRANT_SCHEMA,
    schemaVersion,
    issuedAt,
    incidentChat: { chatId, participantRevision, participants, participantSnapshotSha256: snapshotHash },
    ...(owner ? { owner } : {}),
    ...(incidentQueryGroups ? { incidentQueryGroups } : {}),
    jeff,
    imessage: {
      sourceAccount,
      recipientGuardContract: RECIPIENT_GUARD_CONTRACT,
      ...(schemaVersion === 2 ? { anyLocalGroup } : {}),
    },
    monitor: { sameIncidentCooldownSeconds: cooldown },
    sen,
    colleagueZone,
    research,
  });
}

function validateIncidentQueryGroups(input, owner, { allowEmpty = false } = {}) {
  if (!Array.isArray(input) || input.length > 100 || (!allowEmpty && input.length < 1)) {
    throw coded("incident_query_groups_invalid");
  }
  const groups = input.map((item, index) => {
    exactKeys(item, [
      "target",
      "groupRevision",
      "participants",
      "participantSnapshotSha256",
      "memberFingerprint",
    ], `incident query group ${index}`);
    const target = canonicalGroupTarget(item.target);
    const participants = canonicalParticipants(item.participants);
    if (!participants.some((participant) => samePrincipal(participant, owner.principal))) {
      throw coded("incident_query_group_owner_missing");
    }
    const snapshotHash = participantSnapshotSha256(participants);
    if (item.participantSnapshotSha256 !== snapshotHash) throw coded("incident_query_group_snapshot_hash_mismatch");
    if (item.groupRevision !== `sha256:${snapshotHash}`) throw coded("incident_query_group_revision_invalid");
    const memberFingerprint = incidentGroupMemberFingerprint(target, participants);
    if (item.memberFingerprint !== memberFingerprint) throw coded("incident_query_group_member_fingerprint_mismatch");
    return Object.freeze({
      target,
      groupRevision: item.groupRevision,
      participants,
      participantSnapshotSha256: snapshotHash,
      memberFingerprint,
    });
  });
  if (new Set(groups.map((item) => item.target)).size !== groups.length) throw coded("incident_query_group_duplicate");
  return Object.freeze(groups);
}

function requiredBoolean(value, code) {
  if (typeof value !== "boolean") throw coded(code);
  return value;
}

export function canonicalGroupTarget(value) {
  const raw = String(value ?? "").trim();
  const match = /^(chat_(?:id|guid|identifier)):(.+)$/iu.exec(raw);
  if (!match || !match[2].trim() || /[\u0000-\u001f\u007f]/u.test(match[2])) throw coded("incident_query_group_target_invalid");
  if (match[1].toLowerCase() === "chat_id" && !/^[1-9]\d*$/u.test(match[2])) {
    throw coded("incident_query_group_target_invalid");
  }
  return `${match[1].toLowerCase()}:${match[2]}`;
}

export function incidentGroupMemberFingerprint(targetInput, participantsInput) {
  const target = canonicalGroupTarget(targetInput);
  const participants = canonicalParticipants(participantsInput);
  return sha256(`group:${target}:${participants.map((item) => item.handle).sort().join(",")}`);
}

function validateScopedPerson(input, label) {
  exactKeys(input, ["profileId", "principal"], label);
  return {
    profileId: bounded(input.profileId, 1, 256, `${label}_profile_id_invalid`),
    principal: normalizePrincipal(input.principal, `${label} principal`),
  };
}

function samePrincipal(left, right) {
  return left?.kind === right?.kind && left?.handle === right?.handle;
}

function validateColleagueZone(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw coded("colleague_zone_invalid");
  if (input.enabled === false) {
    exactKeys(input, ["enabled"], "colleague zone");
    return { enabled: false };
  }
  exactKeys(input, ["enabled", "sourceId", "pageUrl", "profileId"], "colleague zone");
  if (input.enabled !== true) throw coded("colleague_zone_enabled_invalid");
  if (input.sourceId !== COLLEAGUE_ZONE_SOURCE_ID) throw coded("colleague_zone_source_id_invalid");
  if (input.pageUrl !== COLLEAGUE_ZONE_URL) throw coded("colleague_zone_page_url_invalid");
  return {
    enabled: true,
    sourceId: COLLEAGUE_ZONE_SOURCE_ID,
    pageUrl: COLLEAGUE_ZONE_URL,
    profileId: bounded(input.profileId, 1, 256, "colleague_zone_profile_id_invalid"),
  };
}

function validateSEN(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw coded("sen_invalid");
  if (input.enabled === false) {
    exactKeys(input, ["enabled"], "sen");
    return { enabled: false };
  }
  exactKeys(input, ["enabled", "mailboxId", "profileId"], "sen");
  if (input.enabled !== true) throw coded("sen_enabled_invalid");
  return {
    enabled: true,
    mailboxId: email(input.mailboxId, "sen_mailbox_invalid"),
    profileId: bounded(input.profileId, 1, 256, "sen_profile_id_invalid"),
  };
}

function validateResearch(input) {
  exactKeys(input, ["enabled", "publicInternet", "knowledgeBase", "polar"], "research");
  if (typeof input.enabled !== "boolean" || typeof input.publicInternet !== "boolean" || typeof input.knowledgeBase !== "boolean") {
    throw coded("research_flags_invalid");
  }
  if (input.enabled && !input.publicInternet && !input.knowledgeBase) throw coded("research_sources_empty");
  exactKeys(input.polar, ["enabled", "collaboratorId"], "polar");
  if (typeof input.polar.enabled !== "boolean") throw coded("polar_enabled_invalid");
  if (!input.enabled && input.polar.enabled) throw coded("polar_requires_research");
  const collaboratorId = bounded(input.polar.collaboratorId, 1, 128, "polar_collaborator_id_invalid");
  if (collaboratorId !== "grokbot:polar") throw coded("polar_collaborator_id_invalid");
  return {
    enabled: input.enabled,
    publicInternet: input.publicInternet,
    knowledgeBase: input.knowledgeBase,
    polar: { enabled: input.polar.enabled, collaboratorId },
  };
}

export function polarResearchAuthorized(grant) {
  return grant?.research?.enabled === true
    && grant?.research?.polar?.enabled === true
    && grant?.research?.polar?.collaboratorId === "grokbot:polar";
}

export function readPrivateGrant(filePath = defaultGrantPath()) {
  const resolved = path.resolve(filePath);
  assertPrivateDirectory(path.dirname(resolved));
  assertPrivateFile(resolved);
  return validatePermissionGrant(JSON.parse(fs.readFileSync(resolved, "utf8")));
}

export function installPrivateGrant(value, { filePath = defaultGrantPath(), replace = false } = {}) {
  const grant = validatePermissionGrant(value);
  const resolved = path.resolve(filePath);
  const directory = ensurePrivateDirectory(path.dirname(resolved));
  if (fs.existsSync(resolved) && !replace) throw coded("grant_exists");
  if (fs.existsSync(resolved)) assertPrivateFile(resolved);
  writePrivateJson(resolved, grant, { backup: fs.existsSync(resolved) });
  assertPrivateDirectory(directory);
  return resolved;
}

export function ensurePrivateDirectory(directory) {
  const resolved = path.resolve(directory);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw coded("private_directory_invalid");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw coded("private_directory_owner_invalid");
  if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(resolved, 0o700);
  return resolved;
}

export function assertPrivateFile(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw coded("private_file_invalid");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw coded("private_file_owner_invalid");
  if ((stat.mode & 0o777) !== 0o600) throw coded("private_file_mode_invalid");
}

export function writePrivateJson(filePath, value, { backup = false } = {}) {
  const resolved = path.resolve(filePath);
  const directory = ensurePrivateDirectory(path.dirname(resolved));
  if (fs.existsSync(resolved)) assertPrivateFile(resolved);
  if (backup && fs.existsSync(resolved)) {
    const backupPath = path.join(directory, `${path.basename(resolved)}.backup.${Date.now()}`);
    fs.copyFileSync(resolved, backupPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backupPath, 0o600);
  }
  const temporary = path.join(directory, `.${path.basename(resolved)}.${process.pid}.${Date.now()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, resolved);
    fs.chmodSync(resolved, 0o600);
    const directoryDescriptor = fs.openSync(directory, "r");
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function assertPrivateDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw coded("grant_parent_invalid");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw coded("grant_parent_owner_invalid");
  if ((stat.mode & 0o777) !== 0o700) throw coded("grant_parent_mode_invalid");
}

function email(value, code) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized) || normalized.length > 254) throw coded(code);
  return normalized;
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
