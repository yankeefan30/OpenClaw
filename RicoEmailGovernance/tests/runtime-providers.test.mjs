import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PersonEmailAuthorizationProvider,
  RecipientGuardGroupAuthorizationProvider,
  deriveGroupAuthorizationRevision,
} from "../runtime-providers.mjs";
import { personAuthorization } from "./fixtures.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rico-runtime-provider-"));
  fs.chmodSync(root, 0o700);
  const emailDirectory = path.join(root, "rico-email-governance");
  fs.mkdirSync(emailDirectory, { mode: 0o700 });
  const authorizationPath = path.join(emailDirectory, "person-authorizations.json");
  const profile = personAuthorization();
  fs.writeFileSync(authorizationPath, `${JSON.stringify({
    schema: "rico.person-email-authorizations",
    schemaVersion: 1,
    authorizations: [profile],
  })}\n`, { mode: 0o600 });
  const groupIdentity = {
    target: "chat_id:42",
    kind: "group",
    access: "approved",
    requireMention: true,
    autoReply: true,
    quietStart: 0,
    quietEnd: 0,
    participants: ["+12145550123", "+12145550124"],
    participantNames: { "+12145550123": "Janet Cummings" },
  };
  const guardPath = path.join(root, "rico-recipient-guard.json");
  fs.writeFileSync(guardPath, `${JSON.stringify({
    schemaVersion: 2,
    paused: false,
    identities: [groupIdentity],
  })}\n`, { mode: 0o600 });
  return { root, authorizationPath, guardPath, profile, groupIdentity };
}

test("person provider loads canonical Swift principals and exposes address-free tool options", async (t) => {
  const h = fixture();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const provider = new PersonEmailAuthorizationProvider(h.authorizationPath);
  const values = await provider.list();
  assert.equal(values.length, 1);
  assert.deepEqual(values[0].principal, { channel: "imessage", kind: "direct", handle: "+12145550123" });
  const options = await provider.listToolOptions();
  assert.deepEqual(options, [{ profileId: h.profile.profileId, displayName: h.profile.displayName, attachmentsAllowed: false }]);
  assert.doesNotMatch(JSON.stringify(options), /janet@example.com|alan\.a\.rosa@gmail\.com/iu);
});

test("group provider derives a stable revision from the exact reviewed policy", async (t) => {
  const h = fixture();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const provider = new RecipientGuardGroupAuthorizationProvider(h.guardPath);
  const authorization = await provider.get("chat_id:42");
  assert.equal(authorization.schema, "rico.group-email-authorization");
  assert.equal(authorization.target, "chat_id:42");
  assert.deepEqual(authorization.participants, ["+12145550123", "+12145550124"]);
  assert.equal(authorization.revision, deriveGroupAuthorizationRevision(h.groupIdentity));
  assert.equal(await provider.revisionFor("chat_id:42"), authorization.revision);
  assert.equal(deriveGroupAuthorizationRevision({ ...h.groupIdentity, participants: [...h.groupIdentity.participants].reverse() }), authorization.revision);
  assert.notEqual(deriveGroupAuthorizationRevision({ ...h.groupIdentity, participants: ["+12145550123"] }), authorization.revision);
});

test("paused, changed, missing, and ambiguous group policies fail closed", async (t) => {
  const h = fixture();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const provider = new RecipientGuardGroupAuthorizationProvider(h.guardPath);
  fs.writeFileSync(h.guardPath, `${JSON.stringify({ schemaVersion: 2, paused: true, identities: [h.groupIdentity] })}\n`, { mode: 0o600 });
  await assert.rejects(provider.get("chat_id:42"), /recipient_guard_group_policy_unavailable/u);
  fs.writeFileSync(h.guardPath, `${JSON.stringify({ schemaVersion: 2, paused: false, identities: [] })}\n`, { mode: 0o600 });
  await assert.rejects(provider.get("chat_id:42"), /recipient_guard_group_not_approved/u);
  fs.writeFileSync(h.guardPath, `${JSON.stringify({ schemaVersion: 2, paused: false, identities: [h.groupIdentity, h.groupIdentity] })}\n`, { mode: 0o600 });
  await assert.rejects(provider.get("chat_id:42"), /recipient_guard_group_ambiguous/u);
});

test("private file and directory modes remain mandatory", async (t) => {
  const h = fixture();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  fs.chmodSync(h.authorizationPath, 0o644);
  await assert.rejects(new PersonEmailAuthorizationProvider(h.authorizationPath).list(), /private_file_mode_invalid/u);
  fs.chmodSync(h.authorizationPath, 0o600);
  fs.chmodSync(h.root, 0o755);
  await assert.rejects(new RecipientGuardGroupAuthorizationProvider(h.guardPath).get("chat_id:42"), /private_directory_mode_invalid/u);
});
