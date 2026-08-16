import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installMeetingHandoffGrant, readMeetingHandoffGrant } from "../grant.mjs";
import { DeliveryLedger } from "../ledger.mjs";
import { meetingGrant } from "./fixtures.mjs";

test("delivery claim is an exclusive private at-most-once reservation", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rico-email-ledger-"));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ledger = new DeliveryLedger(path.join(root, "claims"), () => new Date("2026-08-15T12:00:00.000Z"));
  const requestKey = "a".repeat(64);
  assert.equal(ledger.reserve({ requestKey, action: "person-email", evidence: { principalHash: "b".repeat(64) } }), true);
  assert.equal(ledger.reserve({ requestKey, action: "person-email", evidence: {} }), false);
  const filePath = ledger.claimPath(requestKey, "person-email");
  assert.equal(fs.lstatSync(path.dirname(filePath)).mode & 0o777, 0o700);
  assert.equal(fs.lstatSync(filePath).mode & 0o777, 0o600);
  ledger.complete({ requestKey, action: "person-email", status: "confirmed", evidence: { providerMessageIdHash: "c".repeat(64) } });
  assert.equal(ledger.read({ requestKey, action: "person-email" }).status, "confirmed");
});

test("meeting grant is installed privately, backed up on reviewed replacement, and remains exact", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rico-email-grant-"));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "state", "meeting-grant.json");
  installMeetingHandoffGrant(meetingGrant(), { filePath });
  assert.equal(fs.lstatSync(path.dirname(filePath)).mode & 0o777, 0o700);
  assert.equal(fs.lstatSync(filePath).mode & 0o777, 0o600);
  assert.equal(readMeetingHandoffGrant(filePath).senderAccount, "alan.rosa@cvshealth.com");
  assert.throws(() => installMeetingHandoffGrant(meetingGrant(), { filePath }), /private_file_exists/u);
  installMeetingHandoffGrant(meetingGrant({ senderAccount: "alan.a.rosa@gmail.com" }), { filePath, replace: true });
  assert.equal(readMeetingHandoffGrant(filePath).senderAccount, "alan.a.rosa@gmail.com");
  assert.equal(fs.readdirSync(path.dirname(filePath)).some((name) => name.includes("backup")), true);
});
