import assert from "node:assert/strict";
import test from "node:test";
import { ISTSAuthorizedContextProvider, validateAuthorizedOriginProof } from "../audience-context.mjs";
import {
  incidentGroupMemberFingerprint,
  participantSnapshotSha256,
  validatePermissionGrant,
} from "../grant.mjs";
import {
  PARTICIPANTS,
  fakeAdapter,
  incidentMessage,
  permissionGrant,
} from "./fixtures.mjs";

const OWNER = PARTICIPANTS[1];

function scopedGrant(overrides = {}) {
  const hash = participantSnapshotSha256(PARTICIPANTS);
  const ownerGroupTarget = "chat_id:77";
  return permissionGrant({
    schemaVersion: 2,
    imessage: { anyLocalGroup: false },
    owner: {
      profileId: "fixture-contact-owner-immutable",
      principal: OWNER,
    },
    incidentChat: {
      participantRevision: `sha256:${hash}`,
      participantSnapshotSha256: hash,
    },
    incidentQueryGroups: [{
      target: ownerGroupTarget,
      groupRevision: `sha256:${hash}`,
      participants: PARTICIPANTS,
      participantSnapshotSha256: hash,
      memberFingerprint: incidentGroupMemberFingerprint(ownerGroupTarget, PARTICIPANTS),
    }],
    ...overrides,
  });
}

function origin(grant, audience, overrides = {}) {
  const person = audience === "owner"
    ? grant.owner
    : audience === "jeff"
      ? grant.jeff
      : { profileId: null, principal: PARTICIPANTS[2] };
  return {
    schema: "rico.ists-authorized-origin-proof",
    schemaVersion: 1,
    trusted: true,
    conversationType: "direct",
    audience,
    profileId: person.profileId,
    principal: person.principal,
    messageId: `fixture-${audience}-message`,
    receivedAt: "2026-08-15T12:05:00.000Z",
    group: null,
    ...overrides,
  };
}

test("schema v2 binds one exact owner, Jeff, and immutable incident group snapshot", () => {
  const grant = validatePermissionGrant(scopedGrant());
  assert.equal(grant.schemaVersion, 2);
  assert.deepEqual(grant.owner.principal, OWNER);
  assert.match(grant.incidentChat.participantRevision, /^sha256:[a-f0-9]{64}$/u);

  assert.throws(() => validatePermissionGrant(scopedGrant({
    owner: {
      profileId: "fixture-contact-owner-immutable",
      principal: PARTICIPANTS[0],
    },
  })), /owner_jeff_principal_collision/u);
  assert.throws(() => validatePermissionGrant(scopedGrant({
    incidentChat: { participantRevision: "operator-label" },
  })), /participant_revision_not_snapshot_bound/u);
  assert.throws(() => validatePermissionGrant(scopedGrant({
    incidentQueryGroups: [{
      ...scopedGrant().incidentQueryGroups[0],
      memberFingerprint: "0".repeat(64),
    }],
  })), /incident_query_group_member_fingerprint_mismatch/u);
  assert.throws(() => validatePermissionGrant(scopedGrant({
    incidentQueryGroups: [{
      ...scopedGrant().incidentQueryGroups[0],
      participants: [PARTICIPANTS[0], PARTICIPANTS[2]],
      participantSnapshotSha256: participantSnapshotSha256([PARTICIPANTS[0], PARTICIPANTS[2]]),
      groupRevision: `sha256:${participantSnapshotSha256([PARTICIPANTS[0], PARTICIPANTS[2]])}`,
      memberFingerprint: incidentGroupMemberFingerprint("chat_id:77", [PARTICIPANTS[0], PARTICIPANTS[2]]),
    }],
  })), /incident_query_group_owner_missing/u);
});

test("authorized origin proof accepts only the exact direct owner or Jeff binding", () => {
  const grant = validatePermissionGrant(scopedGrant());
  assert.equal(validateAuthorizedOriginProof(origin(grant, "owner"), grant).audience, "owner");
  assert.equal(validateAuthorizedOriginProof(origin(grant, "jeff"), grant).audience, "jeff");
  assert.throws(() => validateAuthorizedOriginProof(origin(grant, "owner", {
    profileId: grant.jeff.profileId,
  }), grant), /authorized_origin_mismatch/u);
  assert.throws(() => validateAuthorizedOriginProof(origin(grant, "jeff", {
    conversationType: "group",
  }), grant), /authorized_group_audience_invalid/u);
  assert.throws(() => validateAuthorizedOriginProof(origin(grant, "jeff", {
    audience: "group_participant",
  }), grant), /authorized_direct_audience_invalid/u);
});

test("owner and current participant group proofs are bound to one reviewed group revision and member fingerprint", () => {
  const grant = validatePermissionGrant(scopedGrant());
  const group = grant.incidentQueryGroups[0];
  const proof = origin(grant, "owner", {
    conversationType: "group",
    group: {
      target: group.target,
      groupRevision: group.groupRevision,
      memberFingerprint: group.memberFingerprint,
    },
  });
  assert.equal(validateAuthorizedOriginProof(proof, grant).conversationType, "group");
  const participantProof = origin(grant, "group_participant", {
    conversationType: "group",
    group: proof.group,
  });
  assert.equal(validateAuthorizedOriginProof(participantProof, grant).audience, "group_participant");
  assert.throws(() => validateAuthorizedOriginProof({
    ...proof,
    group: { ...proof.group, memberFingerprint: "0".repeat(64) },
  }, grant), /authorized_group_mismatch/u);
  assert.throws(() => validateAuthorizedOriginProof({
    ...proof,
    audience: "jeff",
    profileId: grant.jeff.profileId,
    principal: grant.jeff.principal,
  }, grant), /authorized_group_audience_invalid/u);
  assert.throws(() => validateAuthorizedOriginProof({
    ...participantProof,
    principal: { kind: "phone", handle: "+12125550999" },
  }, grant), /authorized_group_participant_mismatch/u);
});

test("owner and Jeff receive source-safe context while the provider never sends", async () => {
  const grant = validatePermissionGrant(scopedGrant());
  const adapter = fakeAdapter(grant, {
    contextMessages: [incidentMessage({ sender: OWNER })],
    summary: "a production identity issue affecting colleague access",
  });
  const provider = new ISTSAuthorizedContextProvider({ permissionGrant: grant, adapter });
  const ownerResult = await provider.prepareForAuthorizedReply({ originProof: origin(grant, "owner") });
  const jeffResult = await provider.prepareForAuthorizedReply({ originProof: origin(grant, "jeff") });
  const group = grant.incidentQueryGroups[0];
  const participantResult = await provider.prepareForAuthorizedReply({
    originProof: origin(grant, "group_participant", {
      conversationType: "group",
      group: {
        target: group.target,
        groupRevision: group.groupRevision,
        memberFingerprint: group.memberFingerprint,
      },
    }),
  });

  assert.equal(ownerResult.schema, "rico.ists-authorized-context");
  assert.match(ownerResult.contextNote, /answering Alan/u);
  assert.match(jeffResult.contextNote, /answering Jeff/u);
  assert.match(participantResult.contextNote, /answering the current group participant/u);
  assert.equal(ownerResult.contextNote.includes("group chat"), false);
  assert.equal(participantResult.contextNote.includes("Colleague Zone"), false);
  assert.equal(adapter.calls.sends.length, 0);
});
