import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  anyGroupListRequest,
  anyGroupPreflightRequest,
  anyGroupReadRequest,
  anyGroupRecipientGuardExclusionRequest,
  buildAnyGroupSendRequest,
  liveParticipantSnapshotSha256,
  validateAnyGroupList,
  validateAnyGroupPreflight,
  validateAnyGroupRead,
  validateAnyGroupRecipientGuardExclusionProof,
} from "../any-group-contracts.mjs";
import {
  discoveredGroup,
  inboundMessage,
  LocalISTSAnyGroupAdapter,
} from "../adapters/any-local-group.mjs";
import { participantSnapshotSha256, sha256, validatePermissionGrant } from "../grant.mjs";
import { renderCurrentStatusResult } from "../RicoEscalationHandoff/result-contract.js";

const SOURCE = "alan.operator@example.test";
const OWNER = { kind: "phone", handle: "+12125550100" };
const JEFF = { kind: "phone", handle: "+12125550101" };
const MEMBER = { kind: "phone", handle: "+12125550102" };
const INCIDENT_PARTICIPANTS = [OWNER, JEFF];

function grant() {
  const snapshot = participantSnapshotSha256(INCIDENT_PARTICIPANTS);
  return validatePermissionGrant({
    schema: "rico.ists-incident-grant", schemaVersion: 2, issuedAt: "2026-08-15T12:00:00.000Z",
    incidentChat: {
      chatId: "iMessage;-;incident", participantRevision: `sha256:${snapshot}`,
      participants: INCIDENT_PARTICIPANTS, participantSnapshotSha256: snapshot,
    },
    owner: { profileId: "owner-profile", principal: OWNER },
    incidentQueryGroups: [],
    jeff: { profileId: "jeff-profile", principal: JEFF },
    imessage: { sourceAccount: SOURCE, recipientGuardContract: "rico-recipient-guard/v6", anyLocalGroup: true },
    monitor: { sameIncidentCooldownSeconds: 900 },
    sen: { enabled: false }, colleagueZone: { enabled: false },
    research: { enabled: false, publicInternet: false, knowledgeBase: false, polar: { enabled: false, collaboratorId: "grokbot:polar" } },
  });
}

const NOW = new Date("2026-08-15T12:05:00.000Z");

function harness({
  source = `E:${SOURCE}`,
  ack = true,
  now = () => new Date(NOW),
  policy = { schemaVersion: 2, paused: false, identities: [] },
} = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ists-any-group-adapter-"));
  fs.chmodSync(root, 0o700);
  const commands = [];
  const participants = [OWNER, MEMBER];
  const groupRow = {
    id: 44, guid: "iMessage;+;fixture-group", account_login: source, service: "iMessage",
    is_group: true, participants: participants.map((item) => item.handle),
  };
  const recipientGuardPolicyPath = path.join(root, "recipient-guard.json");
  fs.writeFileSync(recipientGuardPolicyPath, `${JSON.stringify(policy)}\n`, { mode: 0o600 });
  fs.chmodSync(recipientGuardPolicyPath, 0o600);
  const run = (_executable, args) => {
    commands.push(args);
    if (args[0] === "account") return JSON.stringify({ accounts: [{ login: source }] });
    if (args[0] === "chats") return JSON.stringify({ ...groupRow, last_message_at: "2026-08-15T12:01:00.000Z" });
    if (args[0] === "group") return JSON.stringify(groupRow);
    if (args[0] === "history") return [
      JSON.stringify({ guid: "from-me", is_from_me: true, sender: OWNER.handle, text: "@rico what is IMT seeing?", created_at: "2026-08-15T12:01:00.000Z" }),
      JSON.stringify({ guid: "inbound", is_from_me: false, sender: MEMBER.handle, text: "@rico what is IMT seeing?", created_at: "2026-08-15T12:01:01.000Z" }),
    ].join("\n");
    if (args[0] === "send") return ack ? JSON.stringify({ guid: `sent-${commands.length}` }) : JSON.stringify({ ok: true });
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  const permissionGrant = grant();
  const adapter = new LocalISTSAnyGroupAdapter({
    permissionGrant, stateDirectory: root, recipientGuardPolicyPath,
    imsgPath: process.execPath, run, now,
  });
  return { root, commands, participants, permissionGrant, adapter, recipientGuardPolicyPath };
}

function neutralRender() {
  return renderCurrentStatusResult(null, { subject: "IMT or Command Center", now: NOW });
}

function sendRequest(h, read, marker) {
  return buildAnyGroupSendRequest(h.permissionGrant, {
    group: read.group,
    sender: MEMBER,
    queryKind: "status",
    render: neutralRender(),
    eventHash: sha256(marker),
  }, { now: NOW });
}

function managedPolicy({ paused = false, access = "approved", autoReply = true, participants = [OWNER.handle, MEMBER.handle] } = {}) {
  return {
    schemaVersion: 2,
    paused,
    identities: [{
      kind: "group",
      target: "chat_id:44",
      access,
      autoReply,
      requireMention: true,
      participants,
    }],
  };
}

function blockedIndividualPolicy(target = MEMBER.handle) {
  return {
    schemaVersion: 2,
    paused: false,
    identities: [{
      kind: "individual",
      target,
      access: "blocked",
      autoReply: false,
      requireMention: true,
    }],
  };
}

test("adapter discovers only exact-account iMessage groups and filters from-me echoes", async () => {
  const h = harness();
  try {
    validateAnyGroupPreflight(await h.adapter.preflightAnyLocalGroups(anyGroupPreflightRequest(h.permissionGrant)), h.permissionGrant);
    const groups = validateAnyGroupList(await h.adapter.listLocalIMessageGroups(anyGroupListRequest(h.permissionGrant)), h.permissionGrant);
    assert.equal(groups.length, 1);
    const request = anyGroupReadRequest(h.permissionGrant, groups[0], { afterAt: "2026-08-15T12:00:00.000Z" });
    const read = validateAnyGroupRead(await h.adapter.readLocalGroupMessages(request), request);
    assert.equal(read.messages.length, 1);
    assert.equal(read.messages[0].messageId, "inbound");
    assert.deepEqual(read.messages[0].sender, MEMBER);
    assert.equal(h.commands.some((args) => args.includes("--attachments")), false);
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

for (const [label, policy, expected] of [
  ["unmanaged", { schemaVersion: 2, paused: false, identities: [] }, { paused: false, managed: false, admitted: false }],
  ["admitted", managedPolicy(), { paused: false, managed: true, admitted: true }],
  ["blocked", managedPolicy({ access: "blocked" }), { paused: false, managed: true, admitted: false }],
  ["disabled", managedPolicy({ autoReply: false }), { paused: false, managed: true, admitted: false }],
  ["membership drifted", managedPolicy({ participants: [OWNER.handle, "+12125550999"] }), { paused: false, managed: true, admitted: false }],
  ["paused", { schemaVersion: 2, paused: true, identities: [] }, { paused: true, managed: false, admitted: false }],
]) {
  test(`Recipient Guard exclusion proof distinguishes ${label} policy state`, async () => {
    const h = harness({ policy });
    try {
      const groups = validateAnyGroupList(
        await h.adapter.listLocalIMessageGroups(anyGroupListRequest(h.permissionGrant)),
        h.permissionGrant,
      );
      const readRequest = anyGroupReadRequest(h.permissionGrant, groups[0]);
      const read = validateAnyGroupRead(await h.adapter.readLocalGroupMessages(readRequest), readRequest);
      const request = anyGroupRecipientGuardExclusionRequest(h.permissionGrant, {
        group: read.group,
        sender: MEMBER,
      });
      const proof = validateAnyGroupRecipientGuardExclusionProof(
        await h.adapter.proveRecipientGuardExclusion(request),
        request,
      );
      assert.deepEqual(proof, {
        recipientGuardPaused: expected.paused,
        recipientGuardManaged: expected.managed,
        recipientGuardAdmitted: expected.admitted,
      });
    } finally {
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  });
}

test("Recipient Guard exclusion proof denies the exact supplied blocked sender in an unmanaged group", async () => {
  const h = harness({ policy: blockedIndividualPolicy() });
  try {
    const groups = validateAnyGroupList(
      await h.adapter.listLocalIMessageGroups(anyGroupListRequest(h.permissionGrant)),
      h.permissionGrant,
    );
    const readRequest = anyGroupReadRequest(h.permissionGrant, groups[0]);
    const read = validateAnyGroupRead(await h.adapter.readLocalGroupMessages(readRequest), readRequest);
    const request = anyGroupRecipientGuardExclusionRequest(h.permissionGrant, {
      group: read.group,
      sender: MEMBER,
    });
    await assert.rejects(
      h.adapter.proveRecipientGuardExclusion(request),
      /any_group_recipient_guard_sender_blocked/u,
    );
    assert.equal(h.commands.some((args) => args[0] === "send"), false);
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test("Recipient Guard exclusion proof does not transfer another participant's block to the supplied sender", async () => {
  const h = harness({ policy: blockedIndividualPolicy(OWNER.handle) });
  try {
    const groups = validateAnyGroupList(
      await h.adapter.listLocalIMessageGroups(anyGroupListRequest(h.permissionGrant)),
      h.permissionGrant,
    );
    const readRequest = anyGroupReadRequest(h.permissionGrant, groups[0]);
    const read = validateAnyGroupRead(await h.adapter.readLocalGroupMessages(readRequest), readRequest);
    const request = anyGroupRecipientGuardExclusionRequest(h.permissionGrant, {
      group: read.group,
      sender: MEMBER,
    });
    const proof = validateAnyGroupRecipientGuardExclusionProof(
      await h.adapter.proveRecipientGuardExclusion(request),
      request,
    );
    assert.deepEqual(proof, {
      recipientGuardPaused: false,
      recipientGuardManaged: false,
      recipientGuardAdmitted: false,
    });
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

for (const [label, policy, code] of [
  ["paused", { schemaVersion: 2, paused: true, identities: [] }, /recipient_guard_paused/u],
  ["admitted", managedPolicy(), /recipient_guard_managed/u],
  ["blocked", managedPolicy({ access: "blocked" }), /recipient_guard_managed/u],
  ["disabled", managedPolicy({ autoReply: false }), /recipient_guard_managed/u],
  ["membership drifted", managedPolicy({ participants: [OWNER.handle, "+12125550999"] }), /recipient_guard_managed/u],
]) {
  test(`final send re-reads Recipient Guard and rejects ${label} policy state`, async () => {
    const h = harness({ policy });
    try {
      const groups = validateAnyGroupList(
        await h.adapter.listLocalIMessageGroups(anyGroupListRequest(h.permissionGrant)),
        h.permissionGrant,
      );
      const readRequest = anyGroupReadRequest(h.permissionGrant, groups[0]);
      const read = validateAnyGroupRead(await h.adapter.readLocalGroupMessages(readRequest), readRequest);
      await assert.rejects(h.adapter.sendSameGroupIncidentReply(sendRequest(h, read, `blocked-${label}`)), code);
      assert.equal(h.commands.some((args) => args[0] === "send"), false);
    } finally {
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  });
}

test("final send re-reads Recipient Guard and denies the exact blocked sender before transport", async () => {
  const h = harness({ policy: blockedIndividualPolicy() });
  try {
    const groups = validateAnyGroupList(
      await h.adapter.listLocalIMessageGroups(anyGroupListRequest(h.permissionGrant)),
      h.permissionGrant,
    );
    const readRequest = anyGroupReadRequest(h.permissionGrant, groups[0]);
    const read = validateAnyGroupRead(await h.adapter.readLocalGroupMessages(readRequest), readRequest);
    await assert.rejects(
      h.adapter.sendSameGroupIncidentReply(sendRequest(h, read, "blocked-individual")),
      /any_group_recipient_guard_sender_blocked/u,
    );
    assert.equal(h.commands.some((args) => args[0] === "send"), false);
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test("source-account mismatch, arbitrary transport prefixes, and sender outside live membership fail closed", async () => {
  for (const source of ["other.account@example.test", `e:${SOURCE}`, `X:${SOURCE}`]) {
    const h = harness({ source });
    try {
      await assert.rejects(
        h.adapter.preflightAnyLocalGroups(anyGroupPreflightRequest(h.permissionGrant)),
        /imessage_source_account_mismatch/u,
      );
    } finally {
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  }

  const h = harness();
  try {
    assert.throws(() => liveParticipantSnapshotSha256([]), /participants_invalid/u);
    assert.throws(() => inboundMessage({
      guid: "outside", is_from_me: false, sender: "+12125550999", text: "@rico what is IMT seeing?",
      created_at: "2026-08-15T12:01:00.000Z",
    }, {
      participants: h.participants,
    }), /sender_not_live/u);
    assert.throws(() => discoveredGroup({
      id: 44, guid: "sms-group", account_login: `E:${SOURCE}`, service: "SMS", is_group: true,
      participants: h.participants.map((item) => item.handle), last_message_at: null,
    }), /service_not_imessage/u);
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test("one-purpose sender binds the exact live group, disables SMS fallback, and requires acknowledgement", async () => {
  const h = harness();
  try {
    const groups = validateAnyGroupList(await h.adapter.listLocalIMessageGroups(anyGroupListRequest(h.permissionGrant)), h.permissionGrant);
    const request = anyGroupReadRequest(h.permissionGrant, groups[0]);
    const read = validateAnyGroupRead(await h.adapter.readLocalGroupMessages(request), request);
    const send = sendRequest(h, read, "event-1");
    const proof = await h.adapter.sendSameGroupIncidentReply(send);
    assert.equal(proof.deliveredAcknowledgement, true);
    const command = h.commands.find((args) => args[0] === "send");
    assert.deepEqual(command.slice(0, 7), ["send", "--chat-id", "44", "--text", send.text, "--service", "imessage"]);
    assert.equal(command.includes("--no-sms-fallback"), true);
    assert.equal(h.commands.some((args) => args[0] === "openclaw"), false);
    await assert.rejects(h.adapter.sendSameGroupIncidentReply(send), /already_reserved/u);
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test("missing delivery acknowledgement is outcome-unknown and never retried", async () => {
  const h = harness({ ack: false });
  try {
    const groups = validateAnyGroupList(await h.adapter.listLocalIMessageGroups(anyGroupListRequest(h.permissionGrant)), h.permissionGrant);
    const request = anyGroupReadRequest(h.permissionGrant, groups[0]);
    const read = validateAnyGroupRead(await h.adapter.readLocalGroupMessages(request), request);
    const send = sendRequest(h, read, "event-unknown");
    await assert.rejects(h.adapter.sendSameGroupIncidentReply(send), /ack_unavailable/u);
    await assert.rejects(h.adapter.sendSameGroupIncidentReply(send), /already_reserved/u);
    assert.equal(h.commands.filter((args) => args[0] === "send").length, 1);
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test("per-group rate limit is durable and blocks the third send in ten minutes", async () => {
  const h = harness();
  try {
    const groups = validateAnyGroupList(await h.adapter.listLocalIMessageGroups(anyGroupListRequest(h.permissionGrant)), h.permissionGrant);
    const request = anyGroupReadRequest(h.permissionGrant, groups[0]);
    const read = validateAnyGroupRead(await h.adapter.readLocalGroupMessages(request), request);
    for (let index = 0; index < 3; index += 1) {
      const send = sendRequest(h, read, `event-${index}`);
      if (index < 2) await h.adapter.sendSameGroupIncidentReply(send);
      else await assert.rejects(h.adapter.sendSameGroupIncidentReply(send), /per_group_rate_limited/u);
    }
    assert.equal(h.commands.filter((args) => args[0] === "send").length, 2);
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test("global rate limit is durable across group identities", async () => {
  const h = harness();
  try {
    h.adapter._writeDeliveryLedger({
      schema: "rico.ists-any-group-delivery-ledger",
      schemaVersion: 1,
      entries: Array.from({ length: 6 }, (_, index) => ({
        idempotencyKey: `rico:ists:any-group:${String(index).padStart(64, "a")}`,
        payloadHash: String(index).padStart(64, "b"),
        groupKey: String(index).padStart(64, "c"),
        state: "delivered",
        reservedAt: "2026-08-15T12:04:00.000Z",
        completedAt: "2026-08-15T12:04:01.000Z",
        acknowledgementHash: String(index).padStart(64, "d"),
        errorCode: null,
      })),
    });
    const groups = validateAnyGroupList(await h.adapter.listLocalIMessageGroups(anyGroupListRequest(h.permissionGrant)), h.permissionGrant);
    const request = anyGroupReadRequest(h.permissionGrant, groups[0]);
    const read = validateAnyGroupRead(await h.adapter.readLocalGroupMessages(request), request);
    const send = sendRequest(h, read, "global-limit-event");
    await assert.rejects(h.adapter.sendSameGroupIncidentReply(send), /global_rate_limited/u);
    assert.equal(h.commands.filter((args) => args[0] === "send").length, 0);
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});
