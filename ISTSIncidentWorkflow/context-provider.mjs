import {
  contextReadRequest,
  colleagueZonePreflightRequest,
  colleagueZoneStatusRequest,
  preflightRequest,
  senPollRequest,
  summaryRequest,
  validateAdapter,
  validateColleagueZoneAdapter,
  validateColleagueZonePreflightProof,
  validateColleagueZoneStatus,
  validateContextRead,
  validateJeffOriginProof,
  validatePreflightProof,
  validateSENPoll,
  validateSummaryProof,
} from "./contracts.mjs";
import { canonicalJson, sha256, validatePermissionGrant } from "./grant.mjs";
import { ISTS_DOMAIN_CONTEXT } from "./definition.mjs";

export class ISTSJeffContextProvider {
  constructor({ permissionGrant, adapter, colleagueZoneAdapter = null }) {
    const validated = validateAdapter(adapter, permissionGrant);
    this.grant = validatePermissionGrant(validated.grant);
    this.adapter = validated.adapter;
    this.colleagueZoneAdapter = validateColleagueZoneAdapter(colleagueZoneAdapter, this.grant);
  }

  async prepareForJeffReply({ originProof }) {
    validateJeffOriginProof(originProof, this.grant);
    const preflight = await this.adapter.preflight(preflightRequest(this.grant));
    validatePreflightProof(preflight, this.grant);
    if (this.grant.colleagueZone.enabled) {
      const sourceProof = await this.colleagueZoneAdapter.preflight(colleagueZonePreflightRequest(this.grant));
      validateColleagueZonePreflightProof(sourceProof, this.grant);
    }

    const read = validateContextRead(
      await this.adapter.readIncidentContext(contextReadRequest(this.grant)),
      this.grant,
    );
    const notifications = await this.#activeSEN();
    const serviceIncidents = await this.#activeServiceStatus();
    const domainNote = domainContextNote();
    if (read.messages.length === 0 && notifications.length === 0 && serviceIncidents.length === 0) {
      return Object.freeze({
        schema: "rico.ists-jeff-context",
        schemaVersion: 1,
        available: true,
        contextNote: domainNote,
        sourceRef: sha256(canonicalJson(ISTS_DOMAIN_CONTEXT)),
        internalUseOnly: true,
        sourceDisclosureForbidden: true,
      });
    }

    const request = summaryRequest(read.messages, notifications, serviceIncidents);
    const summary = validateSummaryProof(await this.adapter.summarizeIncident(request), request);
    const sourceRef = sha256(canonicalJson({
      messages: read.messages.map((item) => sha256(item.messageId)).sort(),
      sen: notifications.map((item) => sha256(item.notificationId)).sort(),
      serviceStatus: serviceIncidents.map((item) => sha256(`${item.incidentId}\0${item.updatedAt}`)).sort(),
    }));
    return Object.freeze({
      schema: "rico.ists-jeff-context",
      schemaVersion: 1,
      available: true,
      contextNote: `Current operational situation: ${summary}. ${domainNote} Use this only as background context when answering Jeff. Do not say or imply how Rico learned it.`,
      sourceRef,
      internalUseOnly: true,
      sourceDisclosureForbidden: true,
    });
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

function domainContextNote() {
  return "Domain vocabulary: IMT and Command Center refer to the CVS Health incident-management function/team associated with Al Sassoon and Jeff Hrdlicka. Do not infer any title, role, identity, access, or action authority from this association.";
}
