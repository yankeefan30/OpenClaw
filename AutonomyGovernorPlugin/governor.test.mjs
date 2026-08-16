import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AutonomyGovernor, computePolicyHash, normalizeMission } from "./governor.js";
import { DurableStateStore } from "./state-store.js";

const baseMission = (changes = {}) => ({
  schema: "rico.autonomy.mission", schemaVersion: 1, id: "daily-brief", revision: 1,
  title: "Daily brief", objective: "Prepare a verified daily brief", mode: "bounded",
  selectors: { agentIds: ["main"], jobIds: ["job-1"], triggers: ["cron"] },
  tools: [{ name: "memory_search", effect: "read" }, { name: "write_file", effect: "write" }],
  outbound: { channels: ["imessage"], targets: ["+15551234567"] },
  budgets: { runsPerDay: 2, toolCallsPerRun: 2, toolCallsPerDay: 3, writeCallsPerDay: 1, outboundPerDay: 1, runtimeSecondsPerRun: 60 },
  completion: { criteria: ["Citations exist"], evidenceRequired: true }, escalation: { conditions: ["Source unavailable"] },
  timeWindow: { timezone: "UTC", startLocal: "00:00", endLocal: "23:59", allowedWeekdays: [1, 2, 3, 4, 5, 6, 7] },
  ...changes,
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rico-governor-test-"));
  const clock = { now: Date.UTC(2024, 0, 1, 12) };
  const store = new DurableStateStore(directory, { now: () => clock.now });
  return { directory, clock, store, governor: new AutonomyGovernor(store, { now: () => clock.now, conversationAccessConfigured: true }) };
}

function activate(governor, mission = baseMission()) {
  const saved = governor.upsert({ mission, idempotencyKey: `upsert-${mission.id}-0001` });
  const active = governor.activate({ id: mission.id, expectedRevision: saved.mission.revision, idempotencyKey: `activate-${mission.id}-0001` }).mission;
  governor.setGlobalPaused(false, { reason: "Reviewed test", idempotencyKey: `global-resume-${mission.id}` });
  return active;
}

test("starts paused, empty, healthy, private, and Gateway-authoritative", () => {
  const { governor } = fixture();
  const status = governor.status();
  assert.equal(status.globalPaused, true);
  assert.equal(status.activeMissionCount, 0);
  assert.equal(status.healthy, true);
  assert.deepEqual(status.permissions, { directory: true, state: true, ledger: true });
  assert.deepEqual(status.enforcement, { verified: true, authority: "gateway", contractVersion: "1.0.0" });
});

test("unbound interactive traffic and ordinary cron pass without a Mission overlay", () => {
  const { governor } = fixture();
  assert.equal(governor.beforeAgentRun({ senderIsOwner: true }, { trigger: "manual", sessionKey: "owner" }).outcome, "pass");
  assert.equal(governor.beforeAgentRun(
    { senderIsOwner: true, channelId: "imessage", senderId: "+15551234567" },
    { trigger: "user", channelId: "imessage", sessionKey: "agent:main:imessage:default:direct:owner" },
  ).outcome, "pass");
  assert.equal(governor.beforeToolCall({ toolName: "write_file", params: {}, toolCallId: "x" }, { sessionKey: "owner", runId: "manual" }), undefined);
  assert.equal(governor.messageSending({ to: "+1", content: "hi" }, { channelId: "imessage", sessionKey: "owner" }), undefined);
  assert.equal(governor.beforeAgentRun({}, { trigger: "cron", jobId: "unknown", runId: "cron-1" }).outcome, "pass");
  assert.equal(governor.beforeAgentRun({}, { trigger: "heartbeat", runId: "hb-1" }).outcome, "pass");
});

test("unknown tools, duplicate intents, budgets, and pause block bounded work", () => {
  const { governor } = fixture();
  const record = activate(governor);
  assert.equal(governor.beforeAgentRun({}, { trigger: "cron", jobId: "job-1", agentId: "main", sessionKey: "s", runId: "r1" }).outcome, "pass");
  assert.match(governor.beforeToolCall({ toolName: "shell", params: {}, toolCallId: "t0" }, { runId: "r1", sessionKey: "s" }).blockReason, /Unknown/);
  assert.equal(governor.beforeToolCall({ toolName: "memory_search", params: {}, toolCallId: "t1" }, { runId: "r1", sessionKey: "s" }), undefined);
  assert.match(governor.beforeToolCall({ toolName: "memory_search", params: {}, toolCallId: "t1" }, { runId: "r1", sessionKey: "s" }).blockReason, /Duplicate/);
  assert.equal(governor.beforeToolCall({ toolName: "write_file", params: {}, toolCallId: "t2" }, { runId: "r1", sessionKey: "s" }), undefined);
  assert.match(governor.beforeToolCall({ toolName: "memory_search", params: {}, toolCallId: "t3" }, { runId: "r1", sessionKey: "s" }).blockReason, /Per-run/);
  governor.pauseMission({ id: record.id, expectedRevision: record.revision, idempotencyKey: "pause-daily-brief" });
  assert.match(governor.beforeToolCall({ toolName: "memory_search", params: {}, toolCallId: "t4" }, { runId: "r1", sessionKey: "s" }).blockReason, /not active/);
});

test("shadow never permits write or outbound side effects", () => {
  const { governor } = fixture();
  activate(governor, baseMission({ mode: "shadow" }));
  governor.beforeAgentRun({}, { trigger: "cron", jobId: "job-1", agentId: "main", sessionKey: "s", runId: "shadow" });
  assert.equal(governor.beforeToolCall({ toolName: "memory_search", params: {}, toolCallId: "read" }, { runId: "shadow", sessionKey: "s" }), undefined);
  assert.match(governor.beforeToolCall({ toolName: "write_file", params: {}, toolCallId: "write" }, { runId: "shadow", sessionKey: "s" }).blockReason, /Shadow/);
  assert.equal(governor.messageSending({ to: "+15551234567", content: "x", metadata: { idempotencyKey: "shadow-message", autonomyRunId: "shadow" } }, { channelId: "imessage", sessionKey: "s" }).cancel, true);
});

test("outbound target, idempotency, and run completion are enforced", () => {
  const { governor, store } = fixture();
  activate(governor);
  governor.beforeAgentRun({}, { trigger: "cron", jobId: "job-1", agentId: "main", sessionKey: "s", runId: "send" });
  assert.equal(governor.messageSending({ to: "+1999", content: "x", metadata: { idempotencyKey: "message-bad", autonomyRunId: "send" } }, { channelId: "imessage", sessionKey: "s" }).cancel, true);
  const allowed = { to: "+15551234567", content: "x", metadata: { idempotencyKey: "message-good", autonomyRunId: "send" } };
  assert.equal(governor.messageSending(allowed, { channelId: "imessage", sessionKey: "s" }), undefined);
  assert.equal(governor.messageSending(allowed, { channelId: "imessage", sessionKey: "s" }).cancel, true);
  governor.agentEnd({ runId: "send", success: true, durationMs: 20 }, {});
  assert.equal(store.snapshot().runs.send.status, "succeeded");
  assert.match(governor.beforeToolCall({ toolName: "memory_search", params: {}, toolCallId: "after-end" }, { runId: "send", sessionKey: "s" }).blockReason, /no longer active/);
  assert.match(governor.messageSending({ ...allowed, metadata: { ...allowed.metadata, idempotencyKey: "after-end-message" } }, { channelId: "imessage", sessionKey: "s" }).cancelReason, /no longer active/);
});

test("state, hash chain, and idempotent results survive restart", () => {
  const { directory, governor } = fixture();
  governor.upsert({ mission: baseMission(), idempotencyKey: "restart-upsert" });
  assert.equal(governor.upsert({ mission: baseMission(), idempotencyKey: "restart-upsert" }).idempotentReplay, true);
  const reopened = new DurableStateStore(directory);
  assert.equal(reopened.healthy, true);
  assert.equal(Object.keys(reopened.snapshot().missions).length, 1);
});

test("timeWindow is enforced and changes policyHash", () => {
  const { governor, clock } = fixture();
  const first = baseMission({ timeWindow: { timezone: "UTC", startLocal: "09:00", endLocal: "17:00", allowedWeekdays: [1] } });
  const second = { ...first, revision: 2, timeWindow: { ...first.timeWindow, endLocal: "18:00" } };
  assert.notEqual(computePolicyHash(normalizeMission(first).manifest), computePolicyHash(normalizeMission(second).manifest));
  activate(governor, first);
  clock.now = Date.UTC(2024, 0, 1, 18);
  assert.equal(governor.beforeAgentRun({}, { trigger: "cron", jobId: "job-1", agentId: "main", runId: "late" }).outcome, "block");
});

test("bounded missions without an enforced timeWindow are rejected", () => {
  const candidate = baseMission();
  delete candidate.timeWindow;
  assert.throws(() => normalizeMission(candidate), /require an enforced timeWindow/);
});

test("lifecycle evaluation and structured evidence checkpoints work", () => {
  const { governor } = fixture();
  const saved = governor.upsert({ mission: baseMission(), idempotencyKey: "life-upsert" });
  assert.equal(governor.evaluate({ missionId: saved.mission.id, action: { kind: "lifecycle", transition: "activate" } }).decision.allowed, true);
  let record = governor.activate({ id: saved.mission.id, expectedRevision: saved.mission.revision, idempotencyKey: "life-activate" }).mission;
  governor.setGlobalPaused(false, { reason: "test", idempotencyKey: "life-resume" });
  governor.beforeAgentRun({}, { trigger: "cron", jobId: "job-1", agentId: "main", runId: "proof-run" });
  for (const phase of ["plan", "policy"]) record = governor.advance({ id: record.id, phase, expectedRevision: record.revision, evidence: [], idempotencyKey: `phase-${phase}` }).mission;
  record = governor.advance({ id: record.id, phase: "execute", runId: "proof-run", expectedRevision: record.revision, evidence: [], idempotencyKey: "phase-execute" }).mission;
  record = governor.advance({ id: record.id, phase: "verify", runId: "proof-run", expectedRevision: record.revision, evidence: [{ id: "report", digest: "a".repeat(64), kind: "artifact" }], idempotencyKey: "phase-verify" }).mission;
  assert.equal(record.evidenceCount, 1);
  assert.equal(typeof record.triggerSummary, "string");
});

test("events page newest-first and stop with a null cursor", () => {
  const { governor } = fixture();
  governor.upsert({ mission: baseMission(), idempotencyKey: "events-upsert" });
  governor.setGlobalPaused(true, { reason: "one", idempotencyKey: "events-pause" });
  governor.setGlobalPaused(false, { reason: "two", idempotencyKey: "events-resume" });
  const first = governor.events({ limit: 2 });
  assert.ok(first.events[0].sequence > first.events[1].sequence);
  const second = governor.events({ limit: 2, cursor: first.nextCursor });
  assert.equal(second.events.length, 1);
  assert.equal(second.nextCursor, null);
});
