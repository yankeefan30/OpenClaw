import {
  colleagueZonePreflightRequest,
  colleagueZoneStatusRequest,
  contextReadRequest,
  preflightRequest,
  senPollRequest,
  summaryRequest,
  validateAdapter,
  validateColleagueZoneAdapter,
  validateColleagueZonePreflightProof,
  validateColleagueZoneStatus,
  validateContextRead,
  validatePreflightProof,
  validateSENPoll,
  validateSummaryProof,
} from "./contracts.mjs";
import { canonicalJson, normalizePrincipal, sha256, validatePermissionGrant } from "./grant.mjs";
import { ISTS_DOMAIN_CONTEXT } from "./definition.mjs";

const AUDIENCES = new Set(["owner", "jeff", "group_participant"]);

/**
 * Supplies source-safe operational context to Alan and Jeff in exact direct
 * conversations, and to the authenticated current speaker in an explicitly
 * bound group that contains Alan. Group admission remains informational only:
 * it never supplies a contact profile, owner authority, or tool authority.
 */
export class ISTSAuthorizedContextProvider {
  constructor({ permissionGrant, adapter, colleagueZoneAdapter = null }) {
    const validated = validateAdapter(adapter, permissionGrant);
    this.grant = validatePermissionGrant(validated.grant);
    if (this.grant.schemaVersion !== 2 || !this.grant.owner) throw coded("ists_owner_scope_grant_required");
    this.adapter = validated.adapter;
    this.colleagueZoneAdapter = validateColleagueZoneAdapter(colleagueZoneAdapter, this.grant);
  }

  async prepareForAuthorizedReply({ originProof }) {
    const origin = validateAuthorizedOriginProof(originProof, this.grant);
    validatePreflightProof(await this.adapter.preflight(preflightRequest(this.grant)), this.grant);
    if (this.grant.colleagueZone.enabled) {
      validateColleagueZonePreflightProof(
        await this.colleagueZoneAdapter.preflight(colleagueZonePreflightRequest(this.grant)),
        this.grant,
      );
    }

    const read = validateContextRead(
      await this.adapter.readIncidentContext(contextReadRequest(this.grant)),
      this.grant,
    );
    const notifications = await this.#activeSEN();
    const serviceIncidents = await this.#activeServiceStatus();
    const domainNote = domainContextNote();
    const audienceName = origin.audience === "owner"
      ? "Alan"
      : origin.audience === "jeff"
        ? "Jeff"
        : "the current group participant";
    if (read.messages.length === 0 && notifications.length === 0 && serviceIncidents.length === 0) {
      return result(domainNote, sha256(canonicalJson(ISTS_DOMAIN_CONTEXT)));
    }

    const request = summaryRequest(read.messages, notifications, serviceIncidents);
    const summary = validateSummaryProof(await this.adapter.summarizeIncident(request), request);
    const sourceRef = sha256(canonicalJson({
      messages: read.messages.map((item) => sha256(item.messageId)).sort(),
      sen: notifications.map((item) => sha256(item.notificationId)).sort(),
      serviceStatus: serviceIncidents.map((item) => sha256(`${item.incidentId}\0${item.updatedAt}`)).sort(),
    }));
    return result(
      `Current operational situation: ${summary}. ${domainNote} Use this only as background context when answering ${audienceName}. Do not say or imply how Rico learned it.`,
      sourceRef,
    );
  }

  async #activeSEN() {
    if (!this.grant.sen.enabled) return [];
    const request = senPollRequest(this.grant);
    return validateSENPoll(await this.adapter.pollActiveSENNotifications(request), this.grant).notifications;
  }

  async #activeServiceStatus() {
    if (!this.grant.colleagueZone.enabled) return [];
    const request = colleagueZoneStatusRequest(this.grant);
    return validateColleagueZoneStatus(
      await this.colleagueZoneAdapter.readActiveServiceStatus(request),
      this.grant,
    ).incidents;
  }
}

export function validateAuthorizedOriginProof(input, grantInput) {
  const grant = validatePermissionGrant(grantInput);
  if (grant.schemaVersion !== 2 || !grant.owner) throw coded("ists_owner_scope_grant_required");
  exactKeys(input, [
    "schema",
    "schemaVersion",
    "trusted",
    "conversationType",
    "audience",
    "profileId",
    "principal",
    "messageId",
    "receivedAt",
    "group",
  ], "authorized origin proof");
  if (input.schema !== "rico.ists-authorized-origin-proof" || input.schemaVersion !== 1
    || input.trusted !== true || !new Set(["direct", "group"]).has(input.conversationType)
    || !AUDIENCES.has(input.audience)) {
    throw coded("authorized_origin_untrusted");
  }
  let group = null;
  if (input.conversationType === "group") {
    if (!new Set(["owner", "group_participant"]).has(input.audience)) {
      throw coded("authorized_group_audience_invalid");
    }
    exactKeys(input.group, ["target", "groupRevision", "memberFingerprint"], "authorized origin group");
    const matching = grant.incidentQueryGroups.filter((item) => item.target === input.group.target);
    if (matching.length !== 1 || matching[0].groupRevision !== input.group.groupRevision
      || matching[0].memberFingerprint !== input.group.memberFingerprint) {
      throw coded("authorized_group_mismatch");
    }
    group = Object.freeze({
      target: matching[0].target,
      groupRevision: matching[0].groupRevision,
      memberFingerprint: matching[0].memberFingerprint,
    });
  } else if (input.group !== null) {
    throw coded("authorized_direct_group_unexpected");
  }
  const principal = normalizePrincipal(input.principal, "authorized origin principal");
  if (input.conversationType === "group") {
    const matching = grant.incidentQueryGroups.find((item) => item.target === group.target);
    if (input.audience === "owner") {
      if (input.profileId !== grant.owner.profileId || !samePrincipal(principal, grant.owner.principal)) {
        throw coded("authorized_origin_mismatch");
      }
    } else {
      if (input.profileId !== null || samePrincipal(principal, grant.owner.principal)
        || !matching.participants.some((participant) => samePrincipal(principal, participant))) {
        throw coded("authorized_group_participant_mismatch");
      }
    }
  } else {
    if (!new Set(["owner", "jeff"]).has(input.audience)) throw coded("authorized_direct_audience_invalid");
    const expected = input.audience === "owner" ? grant.owner : grant.jeff;
    if (input.profileId !== expected.profileId || !samePrincipal(principal, expected.principal)) {
      throw coded("authorized_origin_mismatch");
    }
  }
  return Object.freeze({
    audience: input.audience,
    conversationType: input.conversationType,
    profileId: input.profileId,
    principal,
    messageId: bounded(input.messageId, 1, 4_096, "authorized_origin_message_id_invalid"),
    receivedAt: isoDate(input.receivedAt, "authorized_origin_received_at_invalid"),
    group,
  });
}

function result(contextNote, sourceRef) {
  return Object.freeze({
    schema: "rico.ists-authorized-context",
    schemaVersion: 1,
    available: true,
    contextNote,
    sourceRef,
    internalUseOnly: true,
    sourceDisclosureForbidden: true,
  });
}

function domainContextNote() {
  return "Domain vocabulary: IMT and Command Center refer to the CVS Health incident-management function/team associated with Al Sassoon and Jeff Hrdlicka. Do not infer any title, role, identity, access, or action authority from this association.";
}

function samePrincipal(left, right) {
  return left?.kind === right?.kind && left?.handle === right?.handle;
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
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw coded(`${slug(label)}_fields_invalid`);
  }
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_|_$/gu, "");
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
