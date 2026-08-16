import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installPrivateGrant, readPrivateGrant, validatePermissionGrant } from "../grant.mjs";
import { testGrant } from "./fixtures.mjs";

test("grant fixes the two monitor shapes and normalizes exact identities", () => {
  const grant = testGrant({ mailboxId: " Owner@Corp.Example " });
  const value = validatePermissionGrant(grant);
  assert.equal(value.mailboxId, "owner@corp.example");
  assert.equal(value.folderMonitor.folderPath, "Inbox/Leader");
  assert.equal(value.senderMonitor.folderPath, "Inbox");
  assert.equal(value.imessage.sourceAccount, "owner@personal.example");
  assert.ok(Object.isFrozen(value));
});

test("grant rejects broad folders, non-E.164 destinations, and extra authority", () => {
  assert.throws(() => validatePermissionGrant(testGrant({
    folderMonitor: { folderPath: "Inbox/Leader/Archive", alertText: "alert" },
  })), /directly under Inbox/u);
  assert.throws(() => validatePermissionGrant(testGrant({
    imessage: { sourceAccount: "owner@personal.example", destination: "2125550123" },
  })), /E\.164/u);
  assert.throws(() => validatePermissionGrant({ ...testGrant(), wildcard: true }), /unexpected fields/u);
});

test("private grant installer creates 0700 directory and 0600 file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rico-mail-grant-"));
  try {
    const filePath = path.join(root, "private", "grant.json");
    installPrivateGrant(testGrant(), { filePath });
    assert.equal(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    assert.equal(readPrivateGrant(filePath).mailboxId, "owner@corp.example");
    assert.throws(() => installPrivateGrant(testGrant(), { filePath }), /already exists/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("installer refuses an existing broad directory instead of chmodding it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rico-mail-broad-"));
  try {
    fs.chmodSync(root, 0o755);
    assert.throws(() => installPrivateGrant(testGrant(), { filePath: path.join(root, "grant.json") }), /mode must be 0700/u);
    assert.equal(fs.statSync(root).mode & 0o777, 0o755);
  } finally {
    fs.chmodSync(root, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
