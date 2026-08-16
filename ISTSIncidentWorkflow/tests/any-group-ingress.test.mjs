import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ANY_GROUP_ADAPTER_CONTRACT,
  ANY_GROUP_GLOBAL_LIMIT,
  ANY_GROUP_PER_GROUP_LIMIT,
  ANY_GROUP_RATE_WINDOW_MS,
  ANY_GROUP_RECIPIENT_GUARD_EXCLUSION_CONTRACT,
  ANY_GROUP_SEND_CONTRACT,
  liveParticipantSnapshotSha256,
} from "../any-group-contracts.mjs";
import { ISTSAnyGroupIngressEngine } from "../any-group-ingress.mjs";
import { AnyGroupIngressStateStore } from "../any-group-state-store.mjs";
import { participantSnapshotSha256, validatePermissionGrant } from "../grant.mjs";
import { CURRENT_STATUS_REQUEST_CONTRACT } from "../RicoEscalationHandoff/result-contract.js";

const SOURCE = "alan.operator@example.test";
const OWNER = { kind: "phone", handle: "+12125550100" };
const JEFF = { kind: "phone", handle: "+12125550101" };
const MEMBER = { kind: "phone", handle: "+12125550102" };

function grant() {
  const participants = [OWNER, JEFF];
  const snapshot = participantSnapshotSha256(participants);
  return validatePermissionGrant({
    schema: "rico.ists-incident-grant", schemaVersion: 2, issuedAt: "2026-08-15T12:00:00.000Z",
    incidentChat: {
      chatId: "iMessage;-;incident", participantRevision: `sha256:${snapshot}`,
      participants, participantSnapshotSha256: snapshot,
    },
    owner: { profileId: "owner-profile", principal: OWNER },
    incidentQueryGroups: [],
    jeff: { profileId: "jeff-profile", principal: JEFF },
    imessage: { sourceAccount: SOURCE, recipientGuardContract: "rico-recipient-guard/v6", anyLocalGroup: true },
    monitor: { sameIncidentCooldownSeconds: 900 }, sen: { enabled: false }, colleagueZone: { enabled: false },
    research: { enabled: true, publicInternet: true, knowledgeBase: false, polar: { enabled: true, collaboratorId: "grokbot:polar" } },
  });
}

test("any-local-group handoff requires an explicit Polar research grant", () => {
  const value = grant();
  const unauthorized = validatePermissionGrant({
    ...value,
    research: {
      enabled: false,
      publicInternet: false,
      knowledgeBase: false,
      polar: { enabled: false, collaboratorId: "grokbot:polar" },
    },
  });
  assert.throws(() => new ISTSAnyGroupIngressEngine({
    permissionGrant: unauthorized,
    groupAdapter: {},
    store: {},
    handoffStore: {},
    requestRegistry: {},
  }), /any_local_group_polar_not_authorized/u);
});

function inbound(messageId, sentAt, text, { sender = MEMBER } = {}) {
  return { messageId, sentAt, sender, text, fromMe: false };
}

function fakeGroupAdapter(batches, {
  paused = false,
  managed = false,
  admitted = false,
  proofStates = [],
  proofFailureAt = 0,
  proofErrorCodes = [],
  sendFailure = false,
  sendErrorCode = null,
} = {}) {
  const participants = [OWNER, MEMBER];
  const participantSnapshotSha256 = liveParticipantSnapshotSha256(participants);
  const group = {
    chatRowId: 77, chatGuid: "iMessage;+;not-in-general-rico-allowlist", accountLogin: SOURCE,
    service: "iMessage", isGroup: true, participants, participantSnapshotSha256,
  };
  const discovered = {
    chatRowId: group.chatRowId, chatGuid: group.chatGuid, accountLogin: SOURCE, service: "iMessage",
    isGroup: true, participantSnapshotSha256, lastMessageAt: "2026-08-15T12:10:00.000Z",
  };
  const calls = { sends: [], reads: 0, proofs: 0 };
  return {
    calls,
    async preflightAnyLocalGroups() {
      return {
        ok: true, contract: ANY_GROUP_ADAPTER_CONTRACT, sourceAccount: SOURCE,
        exactLocalSourceAccount: true, readOnlyDiscovery: true, liveMembershipRequired: true,
        ownerMembershipRequired: true, recipientGuardExclusionRequired: true,
        fromMeExcluded: true, sameGroupOnly: true, noSmsFallback: true,
        deliveredAcknowledgement: true, durableIdempotency: true,
        globalRateLimit: ANY_GROUP_GLOBAL_LIMIT, perGroupRateLimit: ANY_GROUP_PER_GROUP_LIMIT,
        rateWindowMilliseconds: ANY_GROUP_RATE_WINDOW_MS, generalRicoPolicyBroadened: false,
        nativeAllowlistBroadened: false, modelOrToolExecutionAllowed: false,
      };
    },
    async listLocalIMessageGroups() {
      return { contract: ANY_GROUP_ADAPTER_CONTRACT, sourceAccount: SOURCE, exactLocalSourceAccount: true, readOnly: true, groups: [discovered] };
    },
    async readLocalGroupMessages() {
      const messages = batches[Math.min(calls.reads, batches.length - 1)] ?? [];
      calls.reads += 1;
      return { contract: ANY_GROUP_ADAPTER_CONTRACT, sourceAccount: SOURCE, readOnly: true, group, agentAuthoredExcluded: true, messages };
    },
    async proveRecipientGuardExclusion(request) {
      calls.proofs += 1;
      if (proofFailureAt === calls.proofs) throw Object.assign(new Error("membership changed"), { code: "membership_changed" });
      const proofErrorCode = proofErrorCodes[calls.proofs - 1];
      if (proofErrorCode) throw Object.assign(new Error(proofErrorCode), { code: proofErrorCode });
      const state = proofStates[calls.proofs - 1] ?? { paused, managed, admitted };
      return {
        contract: ANY_GROUP_RECIPIENT_GUARD_EXCLUSION_CONTRACT,
        sourceAccount: SOURCE,
        chatRowId: group.chatRowId,
        chatGuid: group.chatGuid,
        participantSnapshotSha256: group.participantSnapshotSha256,
        sender: request.sender,
        policySnapshotSha256: "a".repeat(64),
        recipientGuardPaused: state.paused === true,
        recipientGuardManaged: state.managed === true,
        recipientGuardAdmitted: state.admitted === true,
        readOnly: true,
        exactPolicyAndMembership: true,
      };
    },
    async sendSameGroupIncidentReply(request) {
      calls.sends.push(request);
      if (sendFailure) throw Object.assign(new Error("delivery unknown"), { code: "fixture_delivery_outcome_unknown" });
      if (sendErrorCode) throw Object.assign(new Error(sendErrorCode), { code: sendErrorCode });
      return {
        ok: true, contract: ANY_GROUP_SEND_CONTRACT, sourceAccount: SOURCE,
        chatRowId: request.group.chatRowId, chatGuid: request.group.chatGuid,
        participantSnapshotSha256: request.group.participantSnapshotSha256,
        idempotencyKey: request.idempotencyKey, transportMessageId: `transport-${calls.sends.length}`,
        deliveredAcknowledgement: true, sameExactGroup: true, noSmsFallback: true,
        globalRateLimitEnforced: true, perGroupRateLimitEnforced: true,
      };
    },
  };
}

function fakeHandoff({ pending = false, submitError = false } = {}) {
  const calls = { submits: [], waits: [] };
  return {
    calls,
    async submitWithId(input) {
      calls.submits.push(input);
      if (submitError) throw Object.assign(new Error("handoff unavailable"), { code: "handoff_unavailable" });
      return { requestId: input.requestId, audience: input.audience, status: "open", redactions: [] };
    },
    async waitForResult(requestId, audienceScope, options) {
      calls.waits.push({ requestId, audienceScope, options });
      if (pending) return { status: "pending", requestId, audience: "authorized_any_local_group", retryable: true };
      return {
        status: "complete",
        result: {
          requestId,
          audience: "authorized_any_local_group",
          completedAt: "2026-08-15T12:04:30.000Z",
          confidence: "high",
          answer: "The current official update reports a production authentication incident.",
          evidence: ["Current official status verified."],
          unresolvedLimits: ["none"],
          resultContractVersion: 1,
          observedAt: "2026-08-15T12:04:00.000Z",
          sourceClass: "public_authoritative",
          publicCitations: [{ title: "Official service status", url: "https://www.apple.com/support/systemstatus/", publishedAt: null }],
        },
      };
    },
  };
}

function fakeRegistry({ firstDisposition = null } = {}) {
  const entries = new Map();
  const calls = { claims: [], submitted: [], terminal: [] };
  return {
    calls,
    async claim(input) {
      calls.claims.push(input);
      const existing = entries.get(input.eventKey);
      if (existing?.terminal) return { disposition: "duplicate", eventKey: input.eventKey };
      if (existing?.submitted) return { disposition: "resume", eventKey: input.eventKey, requestId: input.requestId, audienceScope: input.audienceScope };
      if (existing) return { disposition: "recover", eventKey: input.eventKey, requestId: input.requestId, audienceScope: input.audienceScope };
      if (firstDisposition === "rate_limited") {
        entries.set(input.eventKey, { ...input, terminal: true });
        return { disposition: "rate_limited", eventKey: input.eventKey };
      }
      entries.set(input.eventKey, { ...input });
      return { disposition: "new", eventKey: input.eventKey, requestId: input.requestId, audienceScope: input.audienceScope };
    },
    async markSubmitted(input) { calls.submitted.push(input); entries.get(input.eventKey).submitted = true; },
    async markTerminal(input) { calls.terminal.push(input); entries.get(input.eventKey).terminal = true; },
  };
}

function fixture(batches, options = {}) {
  const permissionGrant = grant();
  const groups = fakeGroupAdapter(batches, options.group);
  const handoff = fakeHandoff(options.handoff);
  const registry = fakeRegistry(options.registry);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ists-any-group-engine-"));
  fs.chmodSync(root, 0o700);
  const store = new AnyGroupIngressStateStore(path.join(root, "state.json"));
  let now = new Date("2026-08-15T12:02:00.000Z");
  const engine = new ISTSAnyGroupIngressEngine({
    permissionGrant, groupAdapter: groups, store, handoffStore: handoff,
    requestRegistry: registry, now: () => now,
  });
  return { root, groups, handoff, registry, store, engine, setNow: (value) => { now = new Date(value); } };
}

test("first run baselines every local group and never hands off or replies to existing messages", async () => {
  const h = fixture([[inbound("old", "2026-08-15T12:01:00.000Z", "@rico what is IMT seeing?")]]);
  try {
    const result = await h.engine.runOnce();
    assert.equal(result.baseline, true);
    assert.equal(h.handoff.calls.submits.length, 0);
    assert.equal(h.groups.calls.sends.length, 0);
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); }
});

test("an unapproved live group exports only the exact visible question and fixed fields, then Rico sends one same-group result", async () => {
  const question = "@rico what is IMT seeing for authentication right now?";
  const h = fixture([[], [inbound("q1", "2026-08-15T12:03:00.000Z", question)], [inbound("q1", "2026-08-15T12:03:00.000Z", question)]]);
  try {
    await h.engine.runOnce();
    h.setNow("2026-08-15T12:05:00.000Z");
    const sent = await h.engine.runOnce();
    assert.equal(sent.delivered, 1);
    assert.equal(h.handoff.calls.submits.length, 1);
    assert.deepEqual(Object.keys(h.handoff.calls.submits[0]).sort(), [
      "alreadyTried", "audience", "audienceScope", "doneLooksLike", "question", "requestId", "resultContract",
    ]);
    assert.equal(h.handoff.calls.submits[0].question, question);
    assert.equal(h.handoff.calls.submits[0].resultContract, CURRENT_STATUS_REQUEST_CONTRACT);
    assert.equal(h.handoff.calls.submits[0].audience, "authorized_any_local_group");
    assert.match(h.handoff.calls.submits[0].audienceScope, /^[a-f0-9]{64}$/u);
    assert.equal(JSON.stringify(h.handoff.calls.submits[0]).includes(MEMBER.handle), false);
    assert.equal(h.groups.calls.sends.length, 1);
    assert.equal(h.groups.calls.sends[0].group.chatGuid, "iMessage;+;not-in-general-rico-allowlist");
    assert.match(h.groups.calls.sends[0].text, /^Rico:/u);
    assert.match(h.groups.calls.sends[0].text, /https:\/\/www\.apple\.com\/support\/systemstatus\//u);
    assert.equal(/polar|grok|research bench|rico_[0-9]/iu.test(h.groups.calls.sends[0].text), false);
    h.setNow("2026-08-15T12:06:00.000Z");
    await h.engine.runOnce();
    assert.equal(h.groups.calls.sends.length, 1);
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); }
});

for (const [label, group] of [
  ["admitted", { managed: true, admitted: true }],
  ["blocked", { managed: true, admitted: false }],
  ["auto-reply disabled", { managed: true, admitted: false }],
  ["membership drifted", { managed: true, admitted: false }],
  ["Recipient Guard paused", { paused: true, managed: false, admitted: false }],
]) {
  test(`a Recipient Guard ${label} group is excluded before handoff and send`, async () => {
    const h = fixture([[], [inbound(`excluded-${label}`, "2026-08-15T12:03:00.000Z", "@rico what is IMT seeing now?")]], {
      group,
    });
    try {
      await h.engine.runOnce();
      h.setNow("2026-08-15T12:05:00.000Z");
      const result = await h.engine.runOnce();
      assert.equal(result.qualified, 1);
      assert.equal(h.handoff.calls.submits.length, 0);
      assert.equal(h.groups.calls.sends.length, 0);
    } finally { fs.rmSync(h.root, { recursive: true, force: true }); }
  });
}

test("a blocked individual sender is rejected by the initial exclusion proof without handoff or retry", async () => {
  const message = inbound("blocked-sender-initial", "2026-08-15T12:03:00.000Z", "@rico what is IMT seeing now?");
  const h = fixture([[], [message], [message]], {
    group: { proofErrorCodes: ["any_group_recipient_guard_sender_blocked"] },
  });
  try {
    await h.engine.runOnce();
    h.setNow("2026-08-15T12:05:00.000Z");
    const result = await h.engine.runOnce();
    assert.equal(result.rejected, 1);
    assert.equal(result.outcomeUnknown, 0);
    assert.equal(h.handoff.calls.submits.length, 0);
    assert.equal(h.groups.calls.sends.length, 0);
    h.setNow("2026-08-15T12:06:00.000Z");
    await h.engine.runOnce();
    assert.equal(h.handoff.calls.submits.length, 0);
    assert.equal(h.groups.calls.sends.length, 0);
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); }
});

test("static definitions, non-leading mentions, actions, and ordinary messages remain untouched", async () => {
  const h = fixture([[], [
    inbound("n1", "2026-08-15T12:03:00.000Z", "Someone should ask @rico what IMT sees"),
    inbound("n2", "2026-08-15T12:03:01.000Z", "@rico send email about the IMT incident"),
    inbound("n3", "2026-08-15T12:03:02.000Z", "@rico what is IMT?"),
  ]]);
  try {
    await h.engine.runOnce();
    const result = await h.engine.runOnce();
    assert.equal(result.qualified, 0);
    assert.equal(h.handoff.calls.submits.length, 0);
    assert.equal(h.groups.calls.sends.length, 0);
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); }
});

test("a 90-second pending result produces one terminal Rico-neutral reply and replay never sends twice", async () => {
  const message = inbound("pending", "2026-08-15T12:03:00.000Z", "@rico what is IMT seeing now?");
  const h = fixture([[], [message], [message]], { handoff: { pending: true } });
  try {
    await h.engine.runOnce();
    h.setNow("2026-08-15T12:05:00.000Z");
    const result = await h.engine.runOnce();
    assert.equal(result.delivered, 1);
    assert.equal(h.handoff.calls.waits[0].options.maxWaitMs, 90_000);
    assert.equal(h.groups.calls.sends.length, 1);
    assert.match(h.groups.calls.sends[0].text, /^Rico:/u);
    assert.match(h.groups.calls.sends[0].text, /won.t guess/iu);
    h.setNow("2026-08-15T12:08:00.000Z");
    await h.engine.runOnce();
    assert.equal(h.groups.calls.sends.length, 1);
    assert.equal(h.registry.calls.terminal.at(-1).outcome, "unverified");
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); }
});

test("a first rate-limited research claim receives one honest Rico-neutral reply and never submits Polar work", async () => {
  const message = inbound("rate-limited", "2026-08-15T12:03:00.000Z", "@rico what is IMT seeing now?");
  const h = fixture([[], [message], [message]], { registry: { firstDisposition: "rate_limited" } });
  try {
    await h.engine.runOnce();
    h.setNow("2026-08-15T12:05:00.000Z");
    const result = await h.engine.runOnce();
    assert.equal(result.delivered, 1);
    assert.equal(h.handoff.calls.submits.length, 0);
    assert.equal(h.groups.calls.sends.length, 1);
    assert.match(h.groups.calls.sends[0].text, /^Rico:/u);
    assert.match(h.groups.calls.sends[0].text, /won.t guess/iu);
    h.setNow("2026-08-15T12:06:00.000Z");
    await h.engine.runOnce();
    assert.equal(h.groups.calls.sends.length, 1);
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); }
});

test("post-wait membership or admission-generation drift is quarantined without a send", async () => {
  const message = inbound("drift", "2026-08-15T12:03:00.000Z", "@rico what is IMT seeing now?");
  const h = fixture([[], [message], [message]], { group: { proofFailureAt: 2 } });
  try {
    await h.engine.runOnce();
    h.setNow("2026-08-15T12:05:00.000Z");
    const result = await h.engine.runOnce();
    assert.equal(result.outcomeUnknown, 1);
    assert.equal(h.handoff.calls.submits.length, 1);
    assert.equal(h.groups.calls.sends.length, 0);
    h.setNow("2026-08-15T12:08:00.000Z");
    await h.engine.runOnce();
    assert.equal(h.groups.calls.sends.length, 0);
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); }
});

test("a sender blocked during research is rejected by the post-wait exclusion proof without send", async () => {
  const message = inbound("blocked-sender-post-wait", "2026-08-15T12:03:00.000Z", "@rico what is IMT seeing now?");
  const h = fixture([[], [message]], {
    group: { proofErrorCodes: [null, "any_group_recipient_guard_sender_blocked"] },
  });
  try {
    await h.engine.runOnce();
    h.setNow("2026-08-15T12:05:00.000Z");
    const result = await h.engine.runOnce();
    assert.equal(result.rejected, 1);
    assert.equal(result.outcomeUnknown, 0);
    assert.equal(h.handoff.calls.submits.length, 1);
    assert.equal(h.groups.calls.sends.length, 0);
    assert.equal(h.registry.calls.terminal.at(-1).outcome, "failed");
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); }
});

for (const [label, second] of [
  ["paused", { paused: true, managed: false, admitted: false }],
  ["managed", { paused: false, managed: true, admitted: false }],
]) {
  test(`Recipient Guard becoming ${label} during research is quarantined without a send`, async () => {
    const message = inbound(`post-${label}`, "2026-08-15T12:03:00.000Z", "@rico what is IMT seeing now?");
    const h = fixture([[], [message]], {
      group: { proofStates: [{ paused: false, managed: false, admitted: false }, second] },
    });
    try {
      await h.engine.runOnce();
      h.setNow("2026-08-15T12:05:00.000Z");
      const result = await h.engine.runOnce();
      assert.equal(result.delivered, 0);
      assert.equal(h.handoff.calls.submits.length, 1);
      assert.equal(h.groups.calls.sends.length, 0);
      assert.equal(h.registry.calls.terminal.at(-1).outcome, "failed");
    } finally { fs.rmSync(h.root, { recursive: true, force: true }); }
  });
}

test("stale and excessively future-dated inbound questions are marked seen without research or reply", async () => {
  const stale = inbound("stale", "2026-08-15T11:54:59.000Z", "@rico what is IMT seeing now?");
  const future = inbound("future", "2026-08-15T12:07:01.000Z", "@rico what is IMT seeing now?");
  const h = fixture([[], [stale, future], [stale, future]]);
  try {
    await h.engine.runOnce();
    h.setNow("2026-08-15T12:05:00.000Z");
    const result = await h.engine.runOnce();
    assert.equal(result.rejected, 2);
    assert.equal(h.handoff.calls.submits.length, 0);
    assert.equal(h.groups.calls.sends.length, 0);
    assert.equal(h.store.load().seen.length, 2);
    h.setNow("2026-08-15T12:06:00.000Z");
    await h.engine.runOnce();
    assert.equal(h.handoff.calls.submits.length, 0);
    assert.equal(h.groups.calls.sends.length, 0);
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); }
});

test("a post-reservation transport failure is outcome-unknown and is never retried", async () => {
  const message = inbound("unknown", "2026-08-15T12:03:00.000Z", "@rico what is IMT seeing now?");
  const h = fixture([[], [message], [message]], { group: { sendFailure: true } });
  try {
    await h.engine.runOnce();
    h.setNow("2026-08-15T12:05:00.000Z");
    const result = await h.engine.runOnce();
    assert.equal(result.outcomeUnknown, 1);
    assert.equal(h.groups.calls.sends.length, 1);
    assert.equal(h.store.load().outbox[0].state, "outcome-unknown");
    h.setNow("2026-08-15T12:08:00.000Z");
    await h.engine.runOnce();
    assert.equal(h.groups.calls.sends.length, 1);
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); }
});

test("a sender blocked at final send is a terminal rejection rather than an unknown delivery", async () => {
  const message = inbound("blocked-sender-final", "2026-08-15T12:03:00.000Z", "@rico what is IMT seeing now?");
  const h = fixture([[], [message]], {
    group: { sendErrorCode: "any_group_recipient_guard_sender_blocked" },
  });
  try {
    await h.engine.runOnce();
    h.setNow("2026-08-15T12:05:00.000Z");
    const result = await h.engine.runOnce();
    assert.equal(result.rejected, 1);
    assert.equal(result.outcomeUnknown, 0);
    assert.equal(h.groups.calls.sends.length, 1);
    assert.equal(h.registry.calls.terminal.at(-1).outcome, "failed");
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); }
});

test("a crash-window reserved request stays retryable with the same deterministic request ID", async () => {
  const message = inbound("recover", "2026-08-15T12:03:00.000Z", "@rico what is IMT seeing now?");
  const h = fixture([[], [message], [message]], { handoff: { submitError: true } });
  try {
    await h.engine.runOnce();
    h.setNow("2026-08-15T12:05:00.000Z");
    const first = await h.engine.runOnce();
    assert.equal(first.delivered, 0);
    assert.equal(h.groups.calls.sends.length, 0);
    const requestId = h.handoff.calls.submits[0].requestId;
    h.handoff.submitWithId = async (input) => {
      h.handoff.calls.submits.push(input);
      return { requestId: input.requestId, audience: input.audience, status: "open", redactions: [] };
    };
    h.setNow("2026-08-15T12:05:30.000Z");
    const recovered = await h.engine.runOnce();
    assert.equal(recovered.delivered, 1);
    assert.equal(h.handoff.calls.submits.at(-1).requestId, requestId);
    assert.equal(h.groups.calls.sends.length, 1);
  } finally { fs.rmSync(h.root, { recursive: true, force: true }); }
});
