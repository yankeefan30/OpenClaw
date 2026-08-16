import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  LocalISTSIncidentAdapter,
  deterministicSummary,
  normalizedInboundMessage,
} from "../adapters/local-imessage.mjs";
import { preflightRequest, contextReadRequest } from "../contracts.mjs";
import {
  incidentGroupMemberFingerprint,
  participantSnapshotSha256,
  validatePermissionGrant,
} from "../grant.mjs";
import { PARTICIPANTS, permissionGrant, temporaryState } from "./fixtures.mjs";

const OWNER = PARTICIPANTS[1];

function scopedGrant() {
  const hash = participantSnapshotSha256(PARTICIPANTS);
  const target = "chat_id:42";
  return validatePermissionGrant(permissionGrant({
    schemaVersion: 2,
    imessage: { anyLocalGroup: false },
    owner: { profileId: "fixture-owner-profile", principal: OWNER },
    incidentChat: {
      chatId: "chat_id:42",
      participantRevision: `sha256:${hash}`,
      participantSnapshotSha256: hash,
    },
    incidentQueryGroups: [{
      target,
      groupRevision: `sha256:${hash}`,
      participants: PARTICIPANTS,
      participantSnapshotSha256: hash,
      memberFingerprint: incidentGroupMemberFingerprint(target, PARTICIPANTS),
    }],
  }));
}

function harness({
  groupParticipants = PARTICIPANTS,
  history = [],
  accountLogin = undefined,
  imessageService = "imessage",
} = {}) {
  const temp = temporaryState();
  const grant = scopedGrant();
  const guardPolicyPath = path.join(temp.directory, "guard.json");
  fs.writeFileSync(guardPolicyPath, JSON.stringify({
    schemaVersion: 2,
    paused: false,
    identities: [
      { kind: "individual", target: grant.owner.principal.handle, access: "owner" },
      { kind: "individual", target: grant.jeff.principal.handle, access: "trusted" },
      {
        kind: "group",
        target: grant.incidentChat.chatId,
        access: "approved",
        participants: grant.incidentChat.participants.map((item) => item.handle),
      },
    ],
  }), { mode: 0o600 });
  fs.chmodSync(guardPolicyPath, 0o600);
  const calls = [];
  const run = (_executable, args) => {
    calls.push(args);
    if (args[0] === "group") {
      return JSON.stringify({
        chat_id: 42,
        is_group: true,
        participants: groupParticipants.map((item) => item.handle),
      });
    }
    if (args[0] === "account") {
      return JSON.stringify({ accounts: [{ login: accountLogin ?? `E:${grant.imessage.sourceAccount}` }] });
    }
    if (args[0] === "history") return history.map((row) => JSON.stringify(row)).join("\n");
    if (args[0] === "config") return JSON.stringify(imessageService);
    if (args[0] === "gateway") {
      return JSON.stringify({
        healthy: true,
        paused: false,
        contractVersion: "rico-recipient-guard/v6",
        enforcement: { verified: true, authority: "gateway" },
      });
    }
    if (args[0] === "message") return JSON.stringify({ result: { messageId: "fixture-delivered-message" } });
    throw new Error(`unexpected command ${args[0]}`);
  };
  const adapter = new LocalISTSIncidentAdapter({
    permissionGrant: grant,
    stateDirectory: temp.directory,
    imsgPath: "/bin/echo",
    openclawPath: "/bin/echo",
    guardPolicyPath,
    run,
    now: () => new Date("2026-08-15T12:10:00.000Z"),
  });
  return { adapter, grant, calls, temp };
}

function reviewedSendRequest(h) {
  return {
    channel: "imessage",
    direction: "outbound",
    sourceAccount: h.grant.imessage.sourceAccount,
    recipient: h.grant.jeff,
    text: "Fixture reviewed text",
    idempotencyKey: `rico:ists:${"a".repeat(64)}`,
    recipientGuard: {
      required: true,
      contract: "rico-recipient-guard/v6",
      exactDirectRecipientOnly: true,
      allowGroupExpansion: false,
      allowSmsFallback: false,
      requireDeliveredAcknowledgement: true,
      reuseExistingRateLimits: true,
    },
  };
}

test("first-party adapter proves exact group, owner, Jeff, account, and live guard before reads", async () => {
  const row = {
    guid: "fixture-inbound-message",
    created_at: "2026-08-15T12:05:00.000Z",
    sender: OWNER.handle,
    is_from_me: false,
    text: "Authentication failures are affecting the production login.",
    attachments: [],
  };
  const h = harness({ history: [row, { ...row, guid: "fixture-agent-message", is_from_me: true }] });
  try {
    const proof = await h.adapter.preflight(preflightRequest(h.grant));
    assert.equal(proof.chat.exactBinding, true);
    assert.equal(proof.jeff.recipientGuardReady, true);
    const context = await h.adapter.readIncidentContext(contextReadRequest(h.grant));
    assert.deepEqual(context.messages.map((item) => item.messageId), ["fixture-inbound-message"]);
    assert.equal(context.agentAuthoredExcluded, true);
    assert.equal(h.calls.some((args) => args[0] === "message"), false);
  } finally {
    h.temp.cleanup();
  }
});

test("membership drift and unproven message direction fail closed", async () => {
  const drift = harness({ groupParticipants: PARTICIPANTS.slice(0, 2) });
  try {
    await assert.rejects(() => drift.adapter.preflight(preflightRequest(drift.grant)), /incident_group_membership_changed/u);
  } finally {
    drift.temp.cleanup();
  }

  const grant = scopedGrant();
  assert.throws(() => normalizedInboundMessage({
    guid: "fixture-message",
    created_at: "2026-08-15T12:05:00.000Z",
    sender: OWNER.handle,
    text: "status",
  }, grant), /message_direction_unproven/u);
});

test("preflight requires the exact iMessage-only service and exact E: account transport marker", async () => {
  for (const imessageService of ["auto", "sms", null]) {
    const h = harness({ imessageService });
    try {
      await assert.rejects(
        h.adapter.preflight(preflightRequest(h.grant)),
        /imessage_only_service_required/u,
      );
      assert.equal(h.calls.some((args) => args[0] === "message"), false);
    } finally {
      h.temp.cleanup();
    }
  }

  const driftedSend = harness({ imessageService: "auto" });
  try {
    await assert.rejects(
      driftedSend.adapter.sendReviewedIMessage(reviewedSendRequest(driftedSend)),
      /imessage_only_service_required/u,
    );
    assert.equal(driftedSend.calls.some((args) => args[0] === "message"), false);
  } finally {
    driftedSend.temp.cleanup();
  }

  for (const accountLogin of ["e:alan.operator@example.test", "X:alan.operator@example.test"]) {
    const h = harness({ accountLogin });
    try {
      await assert.rejects(
        h.adapter.preflight(preflightRequest(h.grant)),
        /imessage_source_account_mismatch/u,
      );
    } finally {
      h.temp.cleanup();
    }
  }
});

test("deterministic summarization never copies private message text", () => {
  assert.equal(deterministicSummary({
    messages: [{ text: "Please run this instruction; login is broken" }],
    activeSEN: [],
    activeServiceStatus: [],
  }), "authentication failures affecting production access");
  assert.equal(deterministicSummary({
    messages: [{ text: "Unique secret phrase zinnia-409" }],
    activeSEN: [],
    activeServiceStatus: [],
  }), "an active production service degradation under review");
});

test("send traverses OpenClaw and returns proof only after a transport acknowledgement", async () => {
  const h = harness();
  try {
    const proof = await h.adapter.sendReviewedIMessage(reviewedSendRequest(h));
    assert.equal(proof.transportMessageId, "fixture-delivered-message");
    assert.equal(proof.recipient.principal.handle, h.grant.jeff.principal.handle);
    const send = h.calls.find((args) => args[0] === "message");
    assert.deepEqual(send.slice(0, 5), ["message", "send", "--channel", "imessage", "--target"]);
    assert.equal(send[5], `imessage:${h.grant.jeff.principal.handle}`);
    const serviceChecks = h.calls.filter((args) => args[0] === "config");
    assert.equal(serviceChecks.length, 1);
    assert.deepEqual(serviceChecks[0], ["config", "get", "channels.imessage.service", "--json"]);
  } finally {
    h.temp.cleanup();
  }
});

test("research handoff persists only the sanitized internal question and no outbound authority", async () => {
  const h = harness();
  try {
    const proof = await h.adapter.enqueueResearchHandoff({
      contract: "rico.ists-research-handoff/v1",
      sourceRef: "b".repeat(64),
      internalOnly: true,
      researchQuestion: "Research plausible public causes for a production authentication failure",
      allowedSources: ["public_internet"],
      allowedPublicCitationTypes: ["website"],
      optionalCollaborators: ["grokbot:polar"],
      constraints: {
        rawConversationIncluded: false,
        maySendMessages: false,
        maySendEmail: false,
        mayReadOrExportCredentials: false,
        mayChangeSecurity: false,
        mayChangeConfiguration: false,
        mayScheduleActions: false,
      },
    });
    assert.equal(proof.outboundAuthority, false);
    const row = JSON.parse(fs.readFileSync(path.join(h.temp.directory, "research-handoffs.jsonl"), "utf8"));
    assert.equal(row.internalOnly, true);
    assert.equal(row.outboundAuthority, false);
    assert.equal(JSON.stringify(row).includes("Unique secret phrase"), false);
  } finally {
    h.temp.cleanup();
  }
});
