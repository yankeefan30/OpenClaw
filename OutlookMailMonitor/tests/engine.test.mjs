import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OutlookMailMonitorEngine } from "../engine.mjs";
import { MonitorStateStore, streamFor } from "../state-store.mjs";
import { FOLDER_MONITOR_ID, SENDER_MONITOR_ID } from "../definition.mjs";
import { message, testGrant } from "./fixtures.mjs";

function harness({ preflight, pollMetadata, sendIMessage, times } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rico-mail-engine-"));
  const calls = { poll: [], send: [] };
  const grant = testGrant();
  const clock = [...(times ?? ["2026-01-01T12:00:00.000Z"])]
    .map((value) => new Date(value));
  const adapter = {
    preflight: preflight ?? (async () => ({
      ok: true,
      mailboxId: grant.mailboxId,
      metadataOnly: true,
      immutableIds: true,
      createdOnly: true,
      sourceAccount: grant.imessage.sourceAccount,
      destination: grant.imessage.destination,
      imessageOnly: true,
      idempotentSends: true,
    })),
    pollMetadata: async (request) => {
      calls.poll.push(request);
      if (pollMetadata) return pollMetadata(request, calls.poll.length);
      return { items: [], nextCursor: `${request.monitorId}-cursor` };
    },
    sendIMessage: async (request) => {
      calls.send.push(request);
      if (sendIMessage) return sendIMessage(request, calls.send.length);
      return {
        ok: true,
        sourceAccount: grant.imessage.sourceAccount,
        destination: grant.imessage.destination,
        transportMessageId: `sent-${calls.send.length}`,
        sourceIdentityProven: true,
        service: "imessage",
        smsFallbackDisabled: true,
      };
    },
  };
  const store = new MonitorStateStore(path.join(root, "state", "monitor.json"));
  const now = () => clock.length > 1 ? clock.shift() : clock[0];
  const engine = new OutlookMailMonitorEngine({ permissionGrant: grant, adapter, store, now });
  return { root, calls, grant, adapter, store, engine };
}

test("first activation baselines both streams and never alerts existing mail", async (t) => {
  const h = harness({
    pollMetadata: async (request) => ({
      items: [message({
        id: `${request.monitorId}-old`,
        at: "2026-01-01T11:00:00.000Z",
        folderPath: request.folderPath,
        senderAddress: request.senderAddress ?? "sender@corp.example",
      })],
      nextCursor: `${request.monitorId}-cursor-1`,
    }),
  });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const result = await h.engine.runOnce();
  assert.equal(result.alertsConfirmed, 0);
  assert.equal(h.calls.send.length, 0);
  assert.equal(h.calls.poll.length, 2);
  assert.ok(h.calls.poll.every((call) =>
    call.baselineOnly === true
      && call.fields.join(",") === "immutableId,receivedAt,senderAddress"
      && call.immutableIds === true
      && call.createdOnly === true
      && call.maxItems === 10_000));
  const state = h.store.load();
  assert.equal(streamFor(state, FOLDER_MONITOR_ID).records[0].status, "baseline");
  assert.equal(streamFor(state, SENDER_MONITOR_ID).records[0].status, "baseline");
  const persisted = fs.readFileSync(h.store.filePath, "utf8");
  assert.equal(persisted.includes("folder-monitor-old"), false, "raw provider identities are never persisted");
  assert.equal(persisted.includes(h.grant.folderMonitor.alertText), false, "alert copy is never persisted in state");
});

test("new exact metadata alerts once with the private text and pinned route", async (t) => {
  const batches = new Map();
  const h = harness({
    times: ["2026-01-01T12:00:00.000Z", "2026-01-01T12:00:01.000Z", "2026-01-01T12:02:00.000Z", "2026-01-01T12:02:01.000Z"],
    pollMetadata: async (request) => {
      const count = (batches.get(request.monitorId) ?? 0) + 1;
      batches.set(request.monitorId, count);
      return {
        items: count === 1 ? [] : [message({
          id: `${request.monitorId}-new`,
          at: "2026-01-01T12:01:30.000Z",
          folderPath: request.folderPath,
          senderAddress: request.senderAddress ?? "sender@corp.example",
        })],
        nextCursor: `${request.monitorId}-cursor-${count}`,
      };
    },
  });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await h.engine.runOnce();
  const result = await h.engine.runOnce();
  assert.equal(result.alertsConfirmed, 2);
  assert.equal(h.calls.send.length, 2);
  assert.deepEqual(h.calls.send.map((call) => call.text), [h.grant.folderMonitor.alertText, h.grant.senderMonitor.alertText]);
  assert.ok(h.calls.send.every((call) =>
    call.sourceAccount === h.grant.imessage.sourceAccount
      && call.destination === h.grant.imessage.destination
      && call.requireSourceIdentityProof === true
      && call.service === "imessage"
      && call.allowSmsFallback === false
      && /^rico-mail-monitor:[a-f0-9]{64}$/u.test(call.idempotencyKey)));

  await h.engine.runOnce();
  assert.equal(h.calls.send.length, 2, "immutable identities are never delivered twice");
});

test("preflight source mismatch blocks polling and sending", async (t) => {
  const h = harness({
    preflight: async () => ({
      ok: true,
      mailboxId: "owner@corp.example",
      metadataOnly: true,
      immutableIds: true,
      createdOnly: true,
      sourceAccount: "different@personal.example",
      destination: "+12125550123",
      imessageOnly: true,
      idempotentSends: true,
    }),
  });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await assert.rejects(h.engine.runOnce(), /preflight_source_mismatch/u);
  assert.equal(h.calls.poll.length, 0);
  assert.equal(h.calls.send.length, 0);
});

test("sender stream rejects non-exact sender metadata", async (t) => {
  const h = harness({
    pollMetadata: async (request) => ({
      items: request.monitorId === SENDER_MONITOR_ID ? [message({
        id: "wrong-sender",
        at: "2026-01-01T12:01:00.000Z",
        folderPath: request.folderPath,
        senderAddress: "other@corp.example",
      })] : [],
      nextCursor: "cursor",
    }),
  });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await assert.rejects(h.engine.runOnce(), /message_sender_mismatch/u);
  assert.equal(h.calls.send.length, 0);
});

test("unproven send outcome is durably quarantined and never retried", async (t) => {
  const counts = new Map();
  const h = harness({
    times: ["2026-01-01T12:00:00.000Z", "2026-01-01T12:00:01.000Z", "2026-01-01T12:02:00.000Z"],
    pollMetadata: async (request) => {
      const count = (counts.get(request.monitorId) ?? 0) + 1;
      counts.set(request.monitorId, count);
      return {
        items: count === 1 || request.monitorId === SENDER_MONITOR_ID ? [] : [message({
          id: "uncertain",
          at: "2026-01-01T12:01:00.000Z",
          folderPath: request.folderPath,
        })],
        nextCursor: `${request.monitorId}-${count}`,
      };
    },
    sendIMessage: async () => ({
      ok: true,
      sourceAccount: "different@personal.example",
      destination: "+12125550123",
      transportMessageId: "possibly-sent",
      sourceIdentityProven: false,
      service: "imessage",
      smsFallbackDisabled: true,
    }),
  });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await h.engine.runOnce();
  const first = await h.engine.runOnce();
  assert.equal(first.deliveryUnknown, 1);
  assert.equal(h.calls.send.length, 1);
  await h.engine.runOnce();
  assert.equal(h.calls.send.length, 1);
  const state = h.store.load();
  assert.equal(streamFor(state, FOLDER_MONITOR_ID).records[0].status, "outcome-unknown");
});

test("one immutable email cannot alert twice across the two monitor streams", async (t) => {
  const counts = new Map();
  const h = harness({
    times: ["2026-01-01T12:00:00.000Z", "2026-01-01T12:00:01.000Z", "2026-01-01T12:02:00.000Z", "2026-01-01T12:02:01.000Z"],
    pollMetadata: async (request) => {
      const count = (counts.get(request.monitorId) ?? 0) + 1;
      counts.set(request.monitorId, count);
      return {
        items: count === 1 ? [] : [message({
          id: "same-provider-identity",
          at: "2026-01-01T12:01:00.000Z",
          folderPath: request.folderPath,
          senderAddress: request.senderAddress ?? "executive@corp.example",
        })],
        nextCursor: `${request.monitorId}-${count}`,
      };
    },
  });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await h.engine.runOnce();
  const result = await h.engine.runOnce();
  assert.equal(result.alertsConfirmed, 1);
  assert.equal(h.calls.send.length, 1);
});
