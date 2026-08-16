import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installPrivateGrant, readPrivateGrant } from "../grant.mjs";
import { applyLedgerMigration, planLedgerMigration, ReceiptLedger } from "../ledger.mjs";
import { sha256 } from "../policy.mjs";

function temporaryRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "janet-receipt-v2-test-"));
}

function mode(filePath) {
  return fs.statSync(filePath).mode & 0o777;
}

function grantValue() {
  return {
    schemaVersion: 2,
    janetHandle: "+15550100200",
    janetEmailRecipient: "janet.locked@example.test",
    alanGmailSender: "alan.sendas@example.test",
    openCaseOrigin: "https://opencase.example.test",
    heygenOrigin: "https://heygen.example.test",
    capabilityRefs: {
      openCaseSession: "browser-session:opencase",
      heygenSession: "browser-session:heygen",
      geniusScan: "private-ref:genius-scan",
      alanGmail: "mcp:gmail-alan",
      cvsOutlook: "mcp:outlook-cvs",
    },
  };
}

function record(requestKey, index = 1) {
  return {
    chat_guid: `chat-${index}`,
    message_ts: `2026-08-15T12:00:${String(index % 60).padStart(2, "0")}-04:00-${index}`,
    vendor: index % 2 ? "OpenCase" : null,
    run_at: "2026-08-15T16:00:00.000Z",
    request_hash: requestKey,
  };
}

test("grant, recent ledger, and internal evidence use private macOS permissions", () => {
  const root = temporaryRoot();
  const grantPath = path.join(root, "state", "permission-grant.json");
  installPrivateGrant(grantValue(), { filePath: grantPath });
  assert.equal(mode(path.dirname(grantPath)), 0o700);
  assert.equal(mode(grantPath), 0o600);
  assert.equal(readPrivateGrant(grantPath).janetEmailRecipient, "janet.locked@example.test");

  const ledger = new ReceiptLedger(path.join(root, "state", "ledger.json"));
  const requestKey = sha256("request-1");
  assert.equal(ledger.claim({
    requestKey,
    runId: "run-1",
    record: record(requestKey),
    evidence: { senderFingerprint: sha256("sender") },
  }), true);
  assert.equal(mode(ledger.filePath), 0o600);
  assert.equal(mode(ledger.evidencePath), 0o600);
  assert.doesNotMatch(fs.readFileSync(ledger.evidencePath, "utf8"), /janet\.locked|15550100200/u);
});

test("final ledger preserves original chat_guid, message_ts, vendor, outcome and run_at", () => {
  const root = temporaryRoot();
  const ledger = new ReceiptLedger(path.join(root, "state", "ledger.json"));
  const requestKey = sha256("request-exact");
  ledger.claim({ requestKey, runId: "run-1", record: record(requestKey), evidence: {} });
  ledger.finalize({ requestKey, runId: "run-1", vendor: "OpenCase", outcome: "sent", evidence: { reason: "receipt_emailed" } });
  assert.deepEqual(ledger.records(), [{
    chat_guid: "chat-1",
    message_ts: "2026-08-15T12:00:01-04:00-1",
    vendor: "OpenCase",
    outcome: "sent",
    run_at: "2026-08-15T16:00:00.000Z",
    request_hash: requestKey,
  }]);
});

test("recent ledger keeps exactly the last 100 while evidence retains replay claims", () => {
  const root = temporaryRoot();
  const ledger = new ReceiptLedger(path.join(root, "state", "ledger.json"));
  const keys = [];
  for (let index = 0; index < 101; index += 1) {
    const requestKey = sha256(`request-${index}`);
    keys.push(requestKey);
    assert.equal(ledger.claim({ requestKey, runId: `run-${index}`, record: record(requestKey, index + 1), evidence: {} }), true);
  }
  assert.equal(ledger.records().length, 100);
  assert.equal(ledger.records()[0].chat_guid, "chat-2");
  assert.equal(ledger.entries().length, 101);
  assert.equal(ledger.claim({ requestKey: keys[0], runId: "replay", record: record(keys[0], 500), evidence: {} }), false);
});

test("email reservation and source claim are at-most-once barriers", () => {
  const root = temporaryRoot();
  const ledger = new ReceiptLedger(path.join(root, "state", "ledger.json"));
  const requestKey = sha256("same request");
  assert.equal(ledger.claim({ requestKey, runId: "run-1", record: record(requestKey), evidence: {} }), true);
  assert.equal(ledger.claim({ requestKey, runId: "run-2", record: record(requestKey), evidence: {} }), false);
  assert.equal(ledger.reserveEmail({ requestKey, runId: "run-1", evidence: { recipientFingerprint: sha256("recipient") } }), true);
  assert.equal(ledger.reserveEmail({ requestKey, runId: "run-2", evidence: { recipientFingerprint: sha256("recipient") } }), false);
});

test("evidence hash-chain tampering is detected", () => {
  const root = temporaryRoot();
  const ledger = new ReceiptLedger(path.join(root, "state", "ledger.json"));
  const requestKey = sha256("tamper");
  ledger.claim({ requestKey, runId: "run-1", record: record(requestKey), evidence: {} });
  const tampered = fs.readFileSync(ledger.evidencePath, "utf8").replace("claimed", "emailed");
  fs.writeFileSync(ledger.evidencePath, tampered, { mode: 0o600 });
  assert.throws(() => ledger.entries(), /invalid hash/);
});

test("legacy v1 evidence imports replay hashes while preserving the source", () => {
  const root = temporaryRoot();
  const legacy = path.join(root, "legacy", "ledger.jsonl");
  fs.mkdirSync(path.dirname(legacy), { recursive: true, mode: 0o700 });
  const requestKey = sha256("legacy-request");
  const unsigned = {
    schema: "rico.janet-receipt-ledger",
    schemaVersion: 1,
    sequence: 1,
    at: "2026-08-15T16:00:00.000Z",
    requestKey,
    runId: "legacy-run",
    transition: "claimed",
    evidence: {},
    previousHash: "0".repeat(64),
  };
  const entry = { ...unsigned, hash: digest(canonicalJson(unsigned)) };
  fs.writeFileSync(legacy, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  fs.chmodSync(legacy, 0o600);

  const current = path.join(root, "state", "ledger.json");
  const plan = planLedgerMigration({ currentPath: current, candidates: [legacy] });
  assert.equal(plan.format, "v1-evidence");
  const result = applyLedgerMigration(plan);
  assert.equal(result.preservedLegacy, true);
  assert.equal(fs.existsSync(legacy), true);
  const migrated = new ReceiptLedger(current);
  assert.equal(migrated.entries().length, 1);
  assert.equal(migrated.claim({ requestKey, runId: "replay", record: record(requestKey), evidence: {} }), false);
});

test("multiple legacy candidates fail closed", () => {
  const root = temporaryRoot();
  const candidates = [path.join(root, "one.json"), path.join(root, "two.json")];
  for (const file of candidates) {
    fs.writeFileSync(file, "{}\n", { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }
  const plan = planLedgerMigration({ currentPath: path.join(root, "state", "ledger.json"), candidates });
  assert.equal(plan.status, "ambiguous");
  assert.throws(() => applyLedgerMigration(plan), /reviewed ready/);
});

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
