import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EtaHandoffOutbox, createReviewedRicoEtaHandoff } from "../eta-handoff.mjs";

function event(overrides = {}) {
  return {
    schema: "openclaw.uber.alert",
    version: 1,
    type: "driver_arrival_threshold",
    source: "uber:riders-api-v1.2",
    rideRef: "12345678-1234-1234-1234-123456789abc",
    pickupEtaMinutes: 3,
    rideStatus: "accepted",
    createdAt: "2026-08-15T18:00:00.000Z",
    dedupeKey: "a".repeat(64),
    ...overrides,
  };
}

test("ETA handoff targets only the reviewed owner route and has no generic fallback", () => {
  const handoff = createReviewedRicoEtaHandoff(event());
  assert.deepEqual(handoff.recipientRoute, { kind: "reviewed-owner-route", selector: "rico-owner-route" });
  assert.equal(handoff.genericSendFallbackAllowed, false);
  assert.equal(handoff.requiresDeliveryAcknowledgement, true);
  assert.equal(JSON.stringify(handoff).includes("+1"), false);
  assert.equal(handoff.message.text, "Alan, your Uber driver is 3 minutes away.");
});

test("ETA outbox deduplicates and only closes on a matching reviewed-sender receipt", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eta-outbox-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outbox = new EtaHandoffOutbox(root);
  const first = outbox.enqueue(event());
  const second = outbox.enqueue(event());
  assert.equal(first.enqueued, true);
  assert.equal(second.enqueued, false);
  assert.equal(outbox.listPending().length, 1);
  assert.throws(() => outbox.acknowledge({}), /Invalid reviewed/u);
  const receipt = {
    schema: "openclaw.rico.reviewed-imessage-delivery-receipt",
    version: 1,
    handoffId: first.handoff.id,
    sourceDedupeKey: first.handoff.sourceDedupeKey,
    routePolicyId: "owner-route-policy-v1",
    deliveryReceiptRef: "imessage-reviewed-receipt-1",
    acknowledgedAt: "2026-08-15T18:00:05.000Z",
  };
  assert.equal(outbox.acknowledge(receipt).acknowledged, true);
  assert.equal(outbox.listPending().length, 0);
  assert.equal(outbox.enqueue(event()).acknowledged, true);
});

test("ETA handoff rejects events outside the threshold and extra fields", () => {
  assert.throws(() => createReviewedRicoEtaHandoff(event({ pickupEtaMinutes: 4 })), /threshold/u);
  assert.throws(() => createReviewedRicoEtaHandoff({ ...event(), recipient: "+10000000000" }), /fields/u);
});

