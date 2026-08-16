import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  installPrivateGrant,
  participantSnapshotSha256,
  readPrivateGrant,
  validatePermissionGrant,
} from "../grant.mjs";
import { PARTICIPANTS, permissionGrant, temporaryState } from "./fixtures.mjs";

test("grant binds one immutable chat snapshot and one exact Jeff principal", () => {
  const grant = validatePermissionGrant(permissionGrant());
  assert.equal(grant.incidentChat.participantSnapshotSha256, participantSnapshotSha256(PARTICIPANTS));
  assert.equal(grant.jeff.profileId, "fixture-contact-jeff-immutable");
  assert.deepEqual(grant.jeff.principal, { kind: "phone", handle: "+12125550111" });
  assert.equal(grant.imessage.recipientGuardContract, "rico-recipient-guard/v6");
  assert.throws(() => validatePermissionGrant(permissionGrant({
    imessage: { recipientGuardContract: `rico-recipient-guard/${"v4"}` },
  })), /recipient_guard_contract_invalid/u);
  assert.equal(Object.isFrozen(grant), true);
});

test("a display name cannot substitute for immutable chat authorization", () => {
  const input = permissionGrant();
  delete input.incidentChat.chatId;
  input.incidentChat.displayName = "ISTS Incident Text";
  assert.throws(() => validatePermissionGrant(input), /incident_chat_fields_invalid/u);
});

test("participant drift and duplicate principals fail closed", () => {
  const drift = permissionGrant();
  drift.incidentChat.participants[0].handle = "+12125550999";
  assert.throws(() => validatePermissionGrant(drift), /participant_snapshot_hash_mismatch/u);

  const duplicateParticipants = [...PARTICIPANTS, PARTICIPANTS[0]];
  const duplicate = permissionGrant({
    incidentChat: {
      participants: duplicateParticipants,
      participantSnapshotSha256: "0".repeat(64),
    },
  });
  assert.throws(() => validatePermissionGrant(duplicate), /participant_snapshot_duplicate/u);
});

test("SEN authorization is optional but exact when enabled", () => {
  const grant = validatePermissionGrant(permissionGrant({
    sen: {
      enabled: true,
      mailboxId: "Cvs.Operator@Example.Test",
      profileId: "reviewed-outlook-profile",
    },
  }));
  assert.equal(grant.sen.mailboxId, "cvs.operator@example.test");
  assert.equal(grant.sen.profileId, "reviewed-outlook-profile");
  assert.throws(() => validatePermissionGrant(permissionGrant({ sen: { enabled: true } })), /sen_fields_invalid/u);
});

test("Colleague Zone uses one exact overview source and separately reviewed profile", () => {
  const grant = validatePermissionGrant(permissionGrant({
    colleagueZone: {
      enabled: true,
      sourceId: "cvs-colleague-zone:service-status",
      pageUrl: "https://colleaguezone.cvs.com/cz?id=services_status",
      profileId: "reviewed-cvs-status-session",
    },
  }));
  assert.equal(grant.colleagueZone.profileId, "reviewed-cvs-status-session");
  assert.throws(() => validatePermissionGrant(permissionGrant({
    colleagueZone: {
      enabled: true,
      sourceId: "cvs-colleague-zone:service-status",
      pageUrl: "https://colleaguezone.cvs.com/cz?id=another_page",
      profileId: "reviewed-cvs-status-session",
    },
  })), /colleague_zone_page_url_invalid/u);
});

test("Polar is an optional bounded collaborator and cannot be replaced by a broad identity", () => {
  assert.throws(() => validatePermissionGrant(permissionGrant({
    research: { polar: { enabled: true, collaboratorId: "grokbot:any-agent" } },
  })), /polar_collaborator_id_invalid/u);
  assert.throws(() => validatePermissionGrant(permissionGrant({
    research: { enabled: false, polar: { enabled: true, collaboratorId: "grokbot:polar" } },
  })), /polar_requires_research/u);
});

test("private grant install uses 0700 parent and 0600 file", () => {
  const temp = temporaryState();
  try {
    const filePath = path.join(temp.directory, "nested", "permission-grant.json");
    installPrivateGrant(permissionGrant(), { filePath });
    assert.equal(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    assert.equal(readPrivateGrant(filePath).incidentChat.chatId, permissionGrant().incidentChat.chatId);
    assert.throws(() => installPrivateGrant(permissionGrant(), { filePath }), /grant_exists/u);
  } finally {
    temp.cleanup();
  }
});
