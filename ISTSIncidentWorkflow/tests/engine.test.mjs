import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { ISTSIncidentEngine } from "../engine.mjs";
import { validatePermissionGrant } from "../grant.mjs";
import { IncidentStateStore } from "../state-store.mjs";
import {
  fakeAdapter,
  fakeColleagueZoneAdapter,
  incidentMessage,
  permissionGrant,
  preflightProof,
  colleagueZonePreflightProof,
  serviceIncident,
  temporaryState,
} from "./fixtures.mjs";

test("baseline, one new incident alert, research handoff, cooldown, and empty poll are deduplicated", async () => {
  const temp = temporaryState();
  try {
    let now = "2026-08-15T12:00:00.000Z";
    const grant = validatePermissionGrant(permissionGrant());
    const adapter = fakeAdapter(grant, {
      pollBatches: [
        {
          messages: [incidentMessage({ messageId: "existing", sentAt: "2026-08-15T11:59:00.000Z" })],
          nextCursor: "cursor-baseline",
        },
        {
          messages: [incidentMessage({ messageId: "new-1", sentAt: "2026-08-15T12:02:00.000Z" })],
          nextCursor: "cursor-new-1",
        },
        {
          messages: [incidentMessage({ messageId: "new-2", sentAt: "2026-08-15T12:05:00.000Z" })],
          nextCursor: "cursor-new-2",
        },
        { messages: [], nextCursor: "cursor-empty" },
      ],
    });
    const store = new IncidentStateStore(temp.statePath, temp.auditPath);
    const engine = new ISTSIncidentEngine({ permissionGrant: grant, adapter, store, now: () => new Date(now) });

    const baseline = await engine.runOnce();
    assert.equal(baseline.baseline, true);
    assert.equal(adapter.calls.sends.length, 0);
    assert.equal(adapter.calls.research.length, 0);

    now = "2026-08-15T12:03:00.000Z";
    const delivered = await engine.runOnce();
    assert.equal(delivered.alertsConfirmed, 1);
    assert.equal(delivered.research, "accepted");
    assert.equal(adapter.calls.sends.length, 1);
    assert.equal(adapter.calls.sends[0].text,
      "I see we are having an issue with a production authentication failure affecting the ISTS portal. This is Rico, Alan Rosa’s autonomous agent. Can I help with anything?");
    assert.deepEqual(adapter.calls.sends[0].recipient, grant.jeff);
    assert.equal(adapter.calls.sends[0].recipientGuard.allowGroupExpansion, false);
    assert.equal(adapter.calls.sends[0].recipientGuard.requireDeliveredAcknowledgement, true);
    assert.deepEqual(adapter.calls.research[0].optionalCollaborators, ["grokbot:polar"]);
    assert.equal(adapter.calls.research[0].constraints.maySendMessages, false);
    assert.equal(adapter.calls.research[0].constraints.mayReadOrExportCredentials, false);
    assert.equal(adapter.calls.research[0].constraints.mayChangeSecurity, false);
    assert.equal(adapter.calls.research[0].constraints.rawConversationIncluded, false);
    assert.deepEqual(adapter.calls.research[0].domainContext.terms, ["IMT", "Command Center"]);
    assert.deepEqual(adapter.calls.research[0].domainContext.associatedPeople, ["Al Sassoon", "Jeff Hrdlicka"]);
    assert.equal(adapter.calls.research[0].domainContext.inferTitlesOrRoles, false);
    assert.equal(adapter.calls.research[0].domainContext.grantsIdentityAccessOrActions, false);
    assert.equal(adapter.calls.research[0].constraints.domainContextMayAuthorize, false);

    now = "2026-08-15T12:06:00.000Z";
    const cooldown = await engine.runOnce();
    assert.equal(cooldown.suppressedCooldown, 1);
    assert.equal(adapter.calls.sends.length, 1);
    assert.equal(adapter.calls.research.length, 1);

    now = "2026-08-15T12:09:00.000Z";
    const empty = await engine.runOnce();
    assert.equal(empty.newMessages, 0);
    assert.equal(empty.alertsConfirmed, 0);
    assert.equal(adapter.calls.sends.length, 1);
    assert.equal(adapter.calls.summaries.length, 2);

    const privateFiles = `${fs.readFileSync(temp.statePath, "utf8")}\n${fs.readFileSync(temp.auditPath, "utf8")}`;
    assert.equal(privateFiles.includes("authentication failure"), false);
    assert.equal(privateFiles.includes("fixture-message"), false);
    assert.equal(store.load().outbox[0].status, "delivered");
  } finally {
    temp.cleanup();
  }
});

test("a new authoritative Colleague Zone incident revision can trigger one reviewed Jeff alert without a new chat message", async () => {
  const temp = temporaryState();
  try {
    let now = "2026-08-15T12:00:00.000Z";
    const grant = validatePermissionGrant(permissionGrant({
      colleagueZone: {
        enabled: true,
        sourceId: "cvs-colleague-zone:service-status",
        pageUrl: "https://colleaguezone.cvs.com/cz?id=services_status",
        profileId: "reviewed-cvs-status-session",
      },
    }));
    const main = fakeAdapter(grant, {
      pollBatches: [
        { messages: [], nextCursor: "cursor-baseline" },
        { messages: [], nextCursor: "cursor-update" },
        { messages: [], nextCursor: "cursor-repeat" },
      ],
    });
    const first = serviceIncident({ updatedAt: "2026-08-15T11:59:00.000Z", durationMinutes: 10 });
    const update = serviceIncident({ updatedAt: "2026-08-15T12:02:00.000Z", durationMinutes: 13 });
    const source = fakeColleagueZoneAdapter(grant, { statusBatches: [[first], [update], [update]] });
    const store = new IncidentStateStore(temp.statePath, temp.auditPath);
    const engine = new ISTSIncidentEngine({
      permissionGrant: grant,
      adapter: main,
      colleagueZoneAdapter: source,
      store,
      now: () => new Date(now),
    });
    const baseline = await engine.runOnce();
    assert.equal(baseline.baseline, true);
    assert.equal(main.calls.sends.length, 0);
    now = "2026-08-15T12:03:00.000Z";
    const delivered = await engine.runOnce();
    assert.equal(delivered.newMessages, 0);
    assert.equal(delivered.newServiceIncidents, 1);
    assert.equal(delivered.alertsConfirmed, 1);
    assert.equal(main.calls.summaries[0].untrustedData.activeServiceStatus.length, 1);
    assert.equal(source.calls.reads[0].triggerAIInsightsGeneration, false);
    assert.equal(source.calls.reads[0].browserAutomationAllowed, true);
    assert.equal(source.calls.reads[0].browserProfileMode, "dedicated-persistent");
    assert.deepEqual(source.calls.reads[0].allowedHTTPMethods, ["GET", "HEAD", "OPTIONS"]);
    assert.equal(source.calls.reads[0].executePageInstructions, false);
    now = "2026-08-15T12:06:00.000Z";
    await engine.runOnce();
    assert.equal(main.calls.sends.length, 1);
  } finally {
    temp.cleanup();
  }
});

test("Colleague Zone re-auth is user-completed and blocks the daemon before any source read", async () => {
  const temp = temporaryState();
  try {
    const grant = validatePermissionGrant(permissionGrant({
      colleagueZone: {
        enabled: true,
        sourceId: "cvs-colleague-zone:service-status",
        pageUrl: "https://colleaguezone.cvs.com/cz?id=services_status",
        profileId: "reviewed-cvs-status-session",
      },
    }));
    const main = fakeAdapter(grant);
    const source = fakeColleagueZoneAdapter(grant, {
      preflightProof: colleagueZonePreflightProof(grant, {
        ok: false,
        authenticationState: "reauth-required",
        authenticatedReadReady: false,
      }),
    });
    const engine = new ISTSIncidentEngine({
      permissionGrant: grant,
      adapter: main,
      colleagueZoneAdapter: source,
      store: new IncidentStateStore(temp.statePath, temp.auditPath),
    });
    let error;
    try {
      await engine.runOnce();
      assert.fail("expected interactive re-auth blocker");
    } catch (caught) {
      error = caught;
    }
    assert.match(error.message, /colleague_zone_reauth_required/u);
    assert.equal(error.reauth.url, "https://colleaguezone.cvs.com/cz?id=services_status");
    assert.equal(error.reauth.daemonHeadlessReadAllowed, true);
    assert.equal(error.reauth.dedicatedBrowserProfileRequired, true);
    assert.equal(error.reauth.browserCookieInspectionOrExportAllowed, false);
    assert.equal(error.reauth.mfaHandling, "user-completed");
    assert.equal(main.calls.polls.length, 0);
    assert.equal(source.calls.reads.length, 0);
  } finally {
    temp.cleanup();
  }
});

test("any AI insight generation attempt or other Colleague Zone side effect fails closed", async () => {
  const temp = temporaryState();
  try {
    const grant = validatePermissionGrant(permissionGrant({
      colleagueZone: {
        enabled: true,
        sourceId: "cvs-colleague-zone:service-status",
        pageUrl: "https://colleaguezone.cvs.com/cz?id=services_status",
        profileId: "reviewed-cvs-status-session",
      },
    }));
    const main = fakeAdapter(grant, { pollBatches: [{ messages: [], nextCursor: "cursor" }] });
    const source = fakeColleagueZoneAdapter(grant, {
      statusBatches: [[serviceIncident()]],
      statusOverride: { aiInsightGenerationAttempted: true, sideEffectsPerformed: true },
    });
    const engine = new ISTSIncidentEngine({
      permissionGrant: grant,
      adapter: main,
      colleagueZoneAdapter: source,
      store: new IncidentStateStore(temp.statePath, temp.auditPath),
    });
    await assert.rejects(() => engine.runOnce(), /colleague_zone_status_source_mismatch/u);
    assert.equal(main.calls.sends.length, 0);
  } finally {
    temp.cleanup();
  }
});

test("ambiguous delivery is quarantined and the same message is never retried", async () => {
  const temp = temporaryState();
  try {
    let now = "2026-08-15T12:00:00.000Z";
    const grant = validatePermissionGrant(permissionGrant({ research: {
      enabled: false,
      publicInternet: false,
      knowledgeBase: false,
      polar: { enabled: false, collaboratorId: "grokbot:polar" },
    } }));
    const adapter = fakeAdapter(grant, {
      sendError: Object.assign(new Error("transport timed out"), { code: "transport_timeout" }),
      pollBatches: [
        { messages: [], nextCursor: "cursor-baseline" },
        { messages: [incidentMessage({ messageId: "uncertain", sentAt: "2026-08-15T12:02:00.000Z" })], nextCursor: "cursor-uncertain" },
        { messages: [incidentMessage({ messageId: "uncertain", sentAt: "2026-08-15T12:02:00.000Z" })], nextCursor: "cursor-repeat" },
      ],
    });
    const store = new IncidentStateStore(temp.statePath, temp.auditPath);
    const engine = new ISTSIncidentEngine({ permissionGrant: grant, adapter, store, now: () => new Date(now) });
    await engine.runOnce();
    now = "2026-08-15T12:03:00.000Z";
    const uncertain = await engine.runOnce();
    assert.equal(uncertain.deliveryUnknown, 1);
    assert.equal(store.load().outbox[0].status, "outcome-unknown");
    assert.equal(store.unresolvedReservations().length, 0);
    now = "2026-08-15T12:06:00.000Z";
    await engine.runOnce();
    assert.equal(adapter.calls.sends.length, 1);
  } finally {
    temp.cleanup();
  }
});

test("participant snapshot drift blocks before summarization or send", async () => {
  const temp = temporaryState();
  try {
    const grant = validatePermissionGrant(permissionGrant());
    const adapter = fakeAdapter(grant, {
      pollBatches: [{
        messages: [],
        nextCursor: "cursor-drift",
        overrides: { participantRevision: "unreviewed-new-revision" },
      }],
    });
    const engine = new ISTSIncidentEngine({
      permissionGrant: grant,
      adapter,
      store: new IncidentStateStore(temp.statePath, temp.auditPath),
    });
    await assert.rejects(() => engine.runOnce(), /incident_chat_snapshot_mismatch/u);
    assert.equal(adapter.calls.summaries.length, 0);
    assert.equal(adapter.calls.sends.length, 0);
  } finally {
    temp.cleanup();
  }
});

test("enabled SEN enrichment fails closed when reviewed Outlook availability is unproven", async () => {
  const temp = temporaryState();
  try {
    const grant = validatePermissionGrant(permissionGrant({
      sen: { enabled: true, mailboxId: "cvs.operator@example.test", profileId: "reviewed-outlook" },
    }));
    const adapter = fakeAdapter(grant, {
      preflightProof: preflightProof(grant, { outlook: { available: false } }),
    });
    const engine = new ISTSIncidentEngine({
      permissionGrant: grant,
      adapter,
      store: new IncidentStateStore(temp.statePath, temp.auditPath),
    });
    await assert.rejects(() => engine.runOnce(), /preflight_outlook_unavailable/u);
    assert.equal(adapter.calls.polls.length, 0);
    assert.equal(adapter.calls.sends.length, 0);
  } finally {
    temp.cleanup();
  }
});

test("summary proof that references a private source blocks without consuming the cursor", async () => {
  const temp = temporaryState();
  try {
    let now = "2026-08-15T12:00:00.000Z";
    const grant = validatePermissionGrant(permissionGrant());
    const adapter = fakeAdapter(grant, {
      summary: "according to the group chat, the production login is failing",
      pollBatches: [
        { messages: [], nextCursor: "cursor-baseline" },
        { messages: [incidentMessage({ messageId: "private-source", sentAt: "2026-08-15T12:02:00.000Z" })], nextCursor: "cursor-private" },
      ],
    });
    const store = new IncidentStateStore(temp.statePath, temp.auditPath);
    const engine = new ISTSIncidentEngine({ permissionGrant: grant, adapter, store, now: () => new Date(now) });
    await engine.runOnce();
    now = "2026-08-15T12:03:00.000Z";
    await assert.rejects(() => engine.runOnce(), /incident_summary_source_reference_forbidden/u);
    assert.equal(adapter.calls.sends.length, 0);
    assert.equal(store.load().cursor, "cursor-baseline");
    assert.equal(store.load().outbox.length, 0);
  } finally {
    temp.cleanup();
  }
});

test("active SEN summaries enrich only a genuinely new incident poll", async () => {
  const temp = temporaryState();
  try {
    let now = "2026-08-15T12:00:00.000Z";
    const grant = validatePermissionGrant(permissionGrant({
      sen: { enabled: true, mailboxId: "cvs.operator@example.test", profileId: "reviewed-outlook" },
    }));
    const adapter = fakeAdapter(grant, {
      senNotifications: [{
        notificationId: "sen-immutable-1",
        receivedAt: "2026-08-15T12:02:30.000Z",
        status: "active",
        safeSummary: "an active authentication severity event affecting the customer portal",
      }],
      pollBatches: [
        { messages: [], nextCursor: "cursor-baseline" },
        { messages: [incidentMessage({ messageId: "sen-related", sentAt: "2026-08-15T12:02:00.000Z" })], nextCursor: "cursor-new" },
        { messages: [], nextCursor: "cursor-empty" },
      ],
    });
    const engine = new ISTSIncidentEngine({
      permissionGrant: grant,
      adapter,
      store: new IncidentStateStore(temp.statePath, temp.auditPath),
      now: () => new Date(now),
    });
    await engine.runOnce();
    assert.equal(adapter.calls.sen.length, 0);
    now = "2026-08-15T12:03:00.000Z";
    await engine.runOnce();
    assert.equal(adapter.calls.sen.length, 1);
    assert.equal(adapter.calls.summaries[0].untrustedData.activeSEN.length, 1);
    now = "2026-08-15T12:06:00.000Z";
    await engine.runOnce();
    assert.equal(adapter.calls.sen.length, 1);
  } finally {
    temp.cleanup();
  }
});
