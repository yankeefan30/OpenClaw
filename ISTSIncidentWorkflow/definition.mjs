export const POLL_INTERVAL_MS = 180_000;
export const RECIPIENT_GUARD_CONTRACT = "rico-recipient-guard/v6";
export const ADAPTER_CONTRACT = "rico.ists-incident-adapter/v1";
export const SUMMARY_CONTRACT = "rico.ists-safe-summary/v1";
export const RESEARCH_CONTRACT = "rico.ists-research-handoff/v1";
export const COLLEAGUE_ZONE_CONTRACT = "rico.cvs-colleague-zone-status-adapter/v2";
export const COLLEAGUE_ZONE_SOURCE_ID = "cvs-colleague-zone:service-status";
export const COLLEAGUE_ZONE_URL = "https://colleaguezone.cvs.com/cz?id=services_status";
export const ISTS_DOMAIN_CONTEXT = deepFreeze({
  terms: ["IMT", "Command Center"],
  meaning: "the CVS Health incident-management function/team",
  associatedPeople: ["Al Sassoon", "Jeff Hrdlicka"],
  inferTitlesOrRoles: false,
  grantsIdentityAccessOrActions: false,
  sourceProvenanceMayBeDisclosed: false,
});

export const ISTS_INCIDENT_WORKFLOW = deepFreeze({
  schema: "rico.workflow.ists-incident",
  schemaVersion: 1,
  id: "rico-ists-incident-v1",
  enabledByDefault: false,
  schedule: { kind: "interval", everyMilliseconds: POLL_INTERVAL_MS },
  authorization: {
    chat: "immutable-id-and-participant-snapshot",
    recipient: "exact-direct-profile-and-principal",
    displayNamesAuthorizeNothing: true,
    modelMayExpandAuthority: false,
  },
  behavior: {
    baselineExistingMessages: true,
    emptyPollsAreSilent: true,
    oneAlertPerNewIncidentFingerprint: true,
    ambiguousDeliveryMayRetry: false,
    privateConversationMayBeQuoted: false,
    privateSourceMayBeNamed: false,
  },
  research: {
    internalOnly: true,
    publicInternetAllowedThroughReviewedAdapter: true,
    knowledgeBaseAllowedThroughReviewedAdapter: true,
    polarOptionalAndBounded: true,
    polarMaySendOrChangeSecurity: false,
  },
  colleagueZone: {
    readOnly: true,
    exactSourceContract: true,
    daemonBrowserAutomation: "dedicated-playwright-profile-only",
    otpOrPasswordCollection: false,
    browserCookieInspectionOrExport: false,
    interactiveReauthOnly: true,
    sessionStorage: "browser-managed-dedicated-profile",
  },
});

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
