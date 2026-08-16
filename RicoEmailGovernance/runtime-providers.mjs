import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readPrivateJson,
} from "./private-store.mjs";
import {
  normalizeIMessageHandle,
  RicoEmailPolicyError,
  safeDisplayName,
  sha256,
  validatePersonEmailAuthorization,
} from "./policy.mjs";

export function defaultPersonEmailAuthorizationPath(homeDirectory = os.homedir()) {
  return path.join(
    path.resolve(homeDirectory),
    "Library",
    "Application Support",
    "OpenClaw Studio",
    "rico-email-governance",
    "person-authorizations.json",
  );
}

export function defaultRecipientGuardPolicyPath(homeDirectory = os.homedir()) {
  return path.join(
    path.resolve(homeDirectory),
    "Library",
    "Application Support",
    "OpenClaw Studio",
    "rico-recipient-guard.json",
  );
}

export class PersonEmailAuthorizationProvider {
  constructor(filePath = defaultPersonEmailAuthorizationPath()) {
    this.filePath = path.resolve(filePath);
  }

  async list() {
    return readPersonEmailAuthorizations(this.filePath);
  }

  async listToolOptions() {
    const values = await this.list();
    return Object.freeze(values.filter((item) => item.email.enabled).map((item) => Object.freeze({
      profileId: item.profileId,
      displayName: item.displayName,
      attachmentsAllowed: item.email.attachmentsAllowed,
    })));
  }
}

export class RecipientGuardGroupAuthorizationProvider {
  constructor(filePath = defaultRecipientGuardPolicyPath()) {
    this.filePath = path.resolve(filePath);
  }

  async get(target) {
    return readRecipientGuardGroupAuthorization(this.filePath, target);
  }

  async revisionFor(target) {
    return (await this.get(target)).revision;
  }
}

export function readPersonEmailAuthorizations(filePath = defaultPersonEmailAuthorizationPath()) {
  const value = readPrivateJson(path.resolve(filePath));
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "authorizations,schema,schemaVersion"
      || value.schema !== "rico.person-email-authorizations" || value.schemaVersion !== 1
      || !Array.isArray(value.authorizations) || value.authorizations.length > 100) {
    throw coded("person_email_authorization_archive_invalid");
  }
  const authorizations = value.authorizations.map(validatePersonEmailAuthorization);
  if (new Set(authorizations.map((item) => item.profileId)).size !== authorizations.length
      || new Set(authorizations.map((item) => item.principal.handle)).size !== authorizations.length) {
    throw coded("person_email_authorization_archive_ambiguous");
  }
  return Object.freeze(authorizations);
}

export function readRecipientGuardGroupAuthorization(filePath = defaultRecipientGuardPolicyPath(), target) {
  const resolvedPath = path.resolve(filePath);
  const requestedTarget = normalizeGroupTarget(target);
  if (!requestedTarget) throw coded("recipient_guard_group_target_invalid");
  const policy = readPrivateJson(resolvedPath);
  if (!policy || typeof policy !== "object" || Array.isArray(policy)
      || policy.schemaVersion !== 2 || policy.paused !== false || !Array.isArray(policy.identities)) {
    throw coded("recipient_guard_group_policy_unavailable");
  }
  const matches = policy.identities.filter((item) => normalizeGroupIdentity(item)?.target === requestedTarget);
  if (matches.length !== 1) throw coded(matches.length === 0
    ? "recipient_guard_group_not_approved"
    : "recipient_guard_group_ambiguous");
  const group = normalizeGroupIdentity(matches[0]);
  if (!group || group.access === "blocked" || group.autoReply !== true || group.participants.length < 1) {
    throw coded("recipient_guard_group_not_approved");
  }
  // `imsg chats` represents group membership as the remote participants and
  // can omit the local user's own handle. Add only the one exact reviewed
  // owner principal from the same private policy. This is sender authority,
  // never an email-recipient expansion.
  const owners = policy.identities
    .filter((item) => item?.kind === "individual" && item.access === "owner" && item.autoReply === true)
    .map((item) => normalizeIMessageHandle(item.target))
    .filter(Boolean);
  if (new Set(owners).size > 1) throw coded("recipient_guard_owner_ambiguous");
  const participants = [...new Set([...group.participants, ...owners])].sort();
  const stat = fs.lstatSync(resolvedPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw coded("recipient_guard_group_policy_unavailable");
  return Object.freeze({
    schema: "rico.group-email-authorization",
    schemaVersion: 1,
    target: group.target,
    participants,
    revision: deriveGroupAuthorizationRevision({ ...group, participants }),
    authorizedAt: stat.mtime.toISOString(),
  });
}

export function deriveGroupAuthorizationRevision(input) {
  const group = normalizeGroupIdentity(input);
  if (!group) throw coded("recipient_guard_group_identity_invalid");
  const digest = sha256(JSON.stringify({
    target: group.target,
    participants: group.participants,
    access: group.access,
    requireMention: group.requireMention,
    autoReply: group.autoReply,
    quietStart: group.quietStart,
    quietEnd: group.quietEnd,
  }));
  // Thirteen hex digits fit exactly inside JavaScript's safe integer range.
  const revision = Number.parseInt(digest.slice(0, 13), 16);
  if (!Number.isSafeInteger(revision)) throw coded("recipient_guard_group_revision_invalid");
  return Math.max(1, revision);
}

function normalizeGroupIdentity(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.kind !== "group") return null;
  const target = normalizeGroupTarget(input.target);
  if (!target || !["blocked", "approved", "trusted", "owner"].includes(input.access)
      || typeof input.requireMention !== "boolean" || typeof input.autoReply !== "boolean"
      || !Number.isInteger(input.quietStart) || input.quietStart < 0 || input.quietStart > 23
      || !Number.isInteger(input.quietEnd) || input.quietEnd < 0 || input.quietEnd > 23
      || !Array.isArray(input.participants) || input.participants.length > 100) return null;
  const participants = input.participants.map(normalizeIMessageHandle);
  if (participants.some((item) => !item) || new Set(participants).size !== participants.length) return null;
  return Object.freeze({
    kind: "group",
    target,
    participants: [...participants].sort(),
    access: input.access,
    requireMention: input.requireMention,
    autoReply: input.autoReply,
    quietStart: input.quietStart,
    quietEnd: input.quietEnd,
  });
}

function normalizeGroupTarget(input) {
  const raw = String(input ?? "").normalize("NFC").trim();
  if (!/^chat_(?:id|guid|identifier):[^\u0000-\u001f\u007f-\u009f\s]{1,512}$/iu.test(raw)) return "";
  const separator = raw.indexOf(":");
  return `${raw.slice(0, separator).toLowerCase()}:${raw.slice(separator + 1)}`;
}

function coded(code) {
  return new RicoEmailPolicyError(code);
}
