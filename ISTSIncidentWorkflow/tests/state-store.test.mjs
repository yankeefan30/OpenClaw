import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { sha256 } from "../grant.mjs";
import { IncidentStateStore, readAudit } from "../state-store.mjs";
import { temporaryState } from "./fixtures.mjs";

const MESSAGE_HASH = sha256("fixture-message");
const INCIDENT_HASH = sha256("fixture-incident");
const OUTBOX_KEY = sha256("fixture-outbox");
const PAYLOAD_HASH = sha256("fixture-payload");
const SOURCE_REF = sha256("fixture-source");

test("state maintains a private hash chain and a delivered outbox acknowledgement", () => {
  const temp = temporaryState();
  try {
    const store = new IncidentStateStore(temp.statePath, temp.auditPath);
    store.baseline({ identityHashes: [], cursor: "cursor-1", at: "2026-08-15T12:00:00.000Z" });
    store.reserveDelivery({
      identityHashes: [MESSAGE_HASH],
      incidentFingerprint: INCIDENT_HASH,
      outboxKey: OUTBOX_KEY,
      payloadHash: PAYLOAD_HASH,
      idempotencyKey: `rico:ists:${OUTBOX_KEY}`,
      sourceRef: SOURCE_REF,
      at: "2026-08-15T12:03:00.000Z",
    });
    assert.equal(store.unresolvedReservations().length, 1);
    store.acknowledgeDelivery({
      outboxKey: OUTBOX_KEY,
      transportMessageId: "sensitive-provider-id",
      guardDecisionId: "sensitive-guard-decision",
      cursor: "cursor-2",
      at: "2026-08-15T12:03:01.000Z",
    });
    const state = store.load();
    assert.equal(state.outbox[0].status, "delivered");
    assert.equal(state.outbox[0].deliveryAck.transportMessageHash, sha256("sensitive-provider-id"));
    assert.equal(state.messages[0].status, "delivered");
    assert.equal(state.incidents[0].lastSentAt, "2026-08-15T12:03:01.000Z");
    assert.equal(store.unresolvedReservations().length, 0);
    assert.equal(readAudit(temp.auditPath).length, 3);
    assert.equal(fs.statSync(temp.statePath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(temp.auditPath).mode & 0o777, 0o600);
    const persisted = `${fs.readFileSync(temp.statePath, "utf8")}\n${fs.readFileSync(temp.auditPath, "utf8")}`;
    assert.equal(persisted.includes("sensitive-provider-id"), false);
    assert.equal(persisted.includes("sensitive-guard-decision"), false);
  } finally {
    temp.cleanup();
  }
});

test("tampering with the audit chain blocks state loading", () => {
  const temp = temporaryState();
  try {
    const store = new IncidentStateStore(temp.statePath, temp.auditPath);
    store.baseline({ identityHashes: [], cursor: "cursor-1", at: "2026-08-15T12:00:00.000Z" });
    const entry = JSON.parse(fs.readFileSync(temp.auditPath, "utf8").trim());
    entry.data.count = 99;
    fs.writeFileSync(temp.auditPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(temp.auditPath, 0o600);
    assert.throws(() => store.load(), /audit_hash_mismatch/u);
  } finally {
    temp.cleanup();
  }
});

test("an unacknowledged reservation remains durable and cannot be silently replayed", () => {
  const temp = temporaryState();
  try {
    const store = new IncidentStateStore(temp.statePath, temp.auditPath);
    store.baseline({ identityHashes: [], cursor: "cursor-1", at: "2026-08-15T12:00:00.000Z" });
    store.reserveDelivery({
      identityHashes: [MESSAGE_HASH],
      incidentFingerprint: INCIDENT_HASH,
      outboxKey: OUTBOX_KEY,
      payloadHash: PAYLOAD_HASH,
      idempotencyKey: `rico:ists:${OUTBOX_KEY}`,
      sourceRef: SOURCE_REF,
      at: "2026-08-15T12:03:00.000Z",
    });
    const reopened = new IncidentStateStore(temp.statePath, temp.auditPath);
    assert.equal(reopened.unresolvedReservations()[0].outboxKey, OUTBOX_KEY);
    assert.throws(() => reopened.reserveDelivery({
      identityHashes: [sha256("different-message")],
      incidentFingerprint: INCIDENT_HASH,
      outboxKey: OUTBOX_KEY,
      payloadHash: PAYLOAD_HASH,
      idempotencyKey: `rico:ists:${OUTBOX_KEY}`,
      sourceRef: SOURCE_REF,
      at: "2026-08-15T12:04:00.000Z",
    }), /outbox_already_reserved/u);
  } finally {
    temp.cleanup();
  }
});
