import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AnyGroupIngressStateStore } from "../any-group-state-store.mjs";

const digest = (character) => character.repeat(64);

test("private state durably baselines cursors and deduplicates events", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ists-any-group-state-"));
  try {
    fs.chmodSync(root, 0o700);
    const file = path.join(root, "state.json");
    const store = new AnyGroupIngressStateStore(file);
    store.baseline({
      groups: [{ groupKey: digest("a"), cursorAt: "2026-08-15T12:00:00.000Z" }],
      seenEventHashes: [digest("b")],
      at: "2026-08-15T12:00:01.000Z",
    });
    assert.equal(store.cursorFor(digest("a")), "2026-08-15T12:00:00.000Z");
    assert.equal(store.hasSeen(digest("b")), true);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.throws(() => store.baseline({ groups: [], seenEventHashes: [], at: new Date() }), /already_initialized/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reservation is durable before delivery and never becomes retryable after an unknown outcome", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ists-any-group-outbox-"));
  try {
    fs.chmodSync(root, 0o700);
    const store = new AnyGroupIngressStateStore(path.join(root, "state.json"));
    store.baseline({ groups: [], seenEventHashes: [], at: "2026-08-15T12:00:00.000Z" });
    store.reserve({
      eventHash: digest("a"), outboxKey: digest("b"), payloadHash: digest("c"),
      groupKey: digest("d"), senderHash: digest("e"), queryKind: "status",
      at: "2026-08-15T12:01:00.000Z",
    });
    assert.deepEqual(store.unresolvedReservations(), [digest("b")]);
    assert.throws(() => store.reserve({
      eventHash: digest("a"), outboxKey: digest("f"), payloadHash: digest("c"),
      groupKey: digest("d"), senderHash: digest("e"), queryKind: "status", at: new Date(),
    }), /already_seen/u);
    store.complete({ outboxKey: digest("b"), outcomeCode: "send_timeout", at: "2026-08-15T12:01:10.000Z" });
    assert.deepEqual(store.unresolvedReservations(), []);
    assert.equal(store.load().outbox[0].state, "outcome-unknown");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("follow-up eligibility is same-group, same-sender, and time bounded", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ists-any-group-followup-"));
  try {
    fs.chmodSync(root, 0o700);
    const store = new AnyGroupIngressStateStore(path.join(root, "state.json"));
    store.baseline({ groups: [], seenEventHashes: [], at: "2026-08-15T12:00:00.000Z" });
    store.reserve({
      eventHash: digest("a"), outboxKey: digest("b"), payloadHash: digest("c"),
      groupKey: digest("d"), senderHash: digest("e"), queryKind: "status", at: "2026-08-15T12:01:00.000Z",
    });
    store.complete({ outboxKey: digest("b"), outcomeCode: "delivered", acknowledgementHash: digest("f"), at: "2026-08-15T12:01:01.000Z" });
    assert.equal(store.followupEligible({ groupKey: digest("d"), senderHash: digest("e"), at: "2026-08-15T12:10:00.000Z" }), true);
    assert.equal(store.followupEligible({ groupKey: digest("d"), senderHash: digest("f"), at: "2026-08-15T12:10:00.000Z" }), false);
    assert.equal(store.followupEligible({ groupKey: digest("d"), senderHash: digest("e"), at: "2026-08-15T12:20:00.000Z" }), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
