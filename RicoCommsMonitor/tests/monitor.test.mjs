import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FIXED_COMMANDS, RicoCommsMonitor, WRITER, isColdStartOutboundLatch } from "../monitor.js";

function clock(initial = "2026-08-16T01:00:00.000Z") {
  let value = new Date(initial);
  return { now: () => new Date(value), advance: (milliseconds) => { value = new Date(value.getTime() + milliseconds); } };
}

async function fixture({ legacy = false } = {}) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rico-comms-monitor-"));
  await fs.promises.chmod(directory, legacy ? 0o755 : 0o700);
  if (legacy) {
    await fs.promises.writeFile(path.join(directory, "state.json"), `${JSON.stringify({
      last_status: "up",
      last_checked_at: 1,
    })}\n`, { mode: 0o644 });
    await fs.promises.writeFile(path.join(directory, "LATEST-DOWN.md"), "# Rico Communications DOWN\n", { mode: 0o644 });
  }
  return fs.promises.realpath(directory);
}

function sample({ channelOk = true, deadLettered = 0, recentErrorAt = null, eventLoopDegraded = false } = {}) {
  return {
    gateway: {
      ok: true,
      value: {
        ok: true,
        eventLoop: { degraded: eventLoopDegraded },
        deliveryQueues: { failed: deadLettered > 0 ? [{ queueName: "outbound", count: deadLettered }] : [] },
      },
    },
    channel: channelOk ? {
      ok: true,
      value: { channels: { imessage: { configured: true, running: true, lastError: null,
        probe: { ok: true, privateApi: { available: false } } } } },
    } : { ok: false, code: "collector_exit_nonzero" },
    stability: {
      ok: true,
      value: { events: recentErrorAt === null ? [] : [{ type: "message.delivery.error", channel: "imessage",
        deliveryKind: "text", outcome: "error", ts: recentErrorAt }] },
    },
    commands: FIXED_COMMANDS,
  };
}

async function readJson(directory, name) {
  return JSON.parse(await fs.promises.readFile(path.join(directory, name), "utf8"));
}

test("healthy launchd run migrates legacy files and clears stale DOWN", async (t) => {
  const directory = await fixture({ legacy: true });
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const time = clock();
  const monitor = new RicoCommsMonitor({ directory, now: time.now, collector: async () => sample(), testMode: true });
  const result = await monitor.run();
  assert.equal(result.controlPlane, "up");
  assert.equal(await fs.promises.stat(directory).then((stat) => stat.mode & 0o777), 0o700);
  assert.equal(await fs.promises.stat(path.join(directory, "state.json")).then((stat) => stat.mode & 0o777), 0o600);
  await assert.rejects(fs.promises.lstat(path.join(directory, "LATEST-DOWN.md")), { code: "ENOENT" });
  assert.equal((await readJson(directory, "state.json")).writer, WRITER);
  assert.equal((await fs.promises.readdir(path.join(directory, "incidents"))).length, 1);
});

test("two transient direct failures do not page or create DOWN", async (t) => {
  const directory = await fixture();
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const time = clock();
  const monitor = new RicoCommsMonitor({ directory, now: time.now, collector: async () => sample({ channelOk: false }), testMode: true });
  for (let index = 0; index < 2; index += 1) {
    const result = await monitor.run();
    assert.equal(result.controlPlane, "unknown");
    assert.equal(result.alertCreated, false);
    time.advance(60_000);
  }
  await assert.rejects(fs.promises.lstat(path.join(directory, "LATEST-DOWN.md")), { code: "ENOENT" });
  await assert.rejects(fs.promises.lstat(path.join(directory, "ALERT.json")), { code: "ENOENT" });
});

test("established UP is held through two transient collection failures", async (t) => {
  const directory = await fixture();
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const time = clock();
  let healthy = true;
  const monitor = new RicoCommsMonitor({ directory, now: time.now,
    collector: async () => sample({ channelOk: healthy }), testMode: true });
  assert.equal((await monitor.run()).controlPlane, "up");
  healthy = false;
  for (let index = 0; index < 2; index += 1) {
    time.advance(60_000);
    const result = await monitor.run();
    assert.equal(result.controlPlane, "up");
    assert.equal(result.alertCreated, false);
    const state = await readJson(directory, "state.json");
    assert.equal(state.control_plane.direct_probe_ok, false);
    assert.equal(state.control_plane.consecutive_failures, index + 1);
  }
  time.advance(60_000);
  const third = await monitor.run();
  assert.deepEqual({ control: third.controlPlane,
    type: (await readJson(directory, "ALERT.json")).type },
  { control: "down", type: "control_plane_down" });
});

test("an unverified sample cannot clear a legacy DOWN file", async (t) => {
  const directory = await fixture({ legacy: true });
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const time = clock();
  const monitor = new RicoCommsMonitor({ directory, now: time.now,
    collector: async () => sample({ channelOk: false }), testMode: true });
  const result = await monitor.run();
  assert.equal(result.controlPlane, "up");
  assert.equal((await readJson(directory, "state.json")).control_plane.direct_probe_ok, false);
  assert.match(await fs.promises.readFile(path.join(directory, "LATEST-DOWN.md"), "utf8"), /DOWN/);
});

test("third consecutive direct failure creates local deduplicated DOWN alert", async (t) => {
  const directory = await fixture();
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const time = clock();
  const monitor = new RicoCommsMonitor({ directory, now: time.now, collector: async () => sample({ channelOk: false }), testMode: true });
  await monitor.run(); time.advance(60_000);
  await monitor.run(); time.advance(60_000);
  const third = await monitor.run();
  assert.deepEqual({ control: third.controlPlane, alert: third.alertCreated }, { control: "down", alert: true });
  assert.equal((await readJson(directory, "ALERT.json")).notification_sent, false);
  assert.match(await fs.promises.readFile(path.join(directory, "LATEST-DOWN.md"), "utf8"), /cannot change configuration/);
  time.advance(60_000);
  assert.equal((await monitor.run()).alertCreated, false);
});

test("recovery needs two successes and removes LATEST-DOWN", async (t) => {
  const directory = await fixture();
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const time = clock();
  let healthy = false;
  const monitor = new RicoCommsMonitor({ directory, now: time.now,
    collector: async () => sample({ channelOk: healthy }), testMode: true });
  for (let index = 0; index < 3; index += 1) { await monitor.run(); time.advance(60_000); }
  healthy = true;
  assert.equal((await monitor.run()).controlPlane, "recovering");
  assert.match(await fs.promises.readFile(path.join(directory, "LATEST-DOWN.md"), "utf8"), /DOWN/);
  time.advance(60_000);
  assert.equal((await monitor.run()).controlPlane, "up");
  await assert.rejects(fs.promises.lstat(path.join(directory, "LATEST-DOWN.md")), { code: "ENOENT" });
});

test("delivery is labeled degraded but pages only after a recent error is confirmed twice", async (t) => {
  const directory = await fixture();
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const time = clock();
  let recent = null;
  const monitor = new RicoCommsMonitor({ directory, now: time.now,
    collector: async () => sample({ deadLettered: 6, recentErrorAt: recent }), testMode: true });
  const oldOnly = await monitor.run();
  assert.deepEqual({ control: oldOnly.controlPlane, delivery: oldOnly.delivery, alert: oldOnly.alertCreated },
    { control: "up", delivery: "degraded", alert: false });
  recent = time.now().getTime(); time.advance(60_000);
  assert.equal((await monitor.run()).alertCreated, false);
  time.advance(60_000);
  const confirmed = await monitor.run();
  assert.equal(confirmed.alertCreated, true);
  assert.equal((await readJson(directory, "ALERT.json")).type, "delivery_degraded");
  await assert.rejects(fs.promises.lstat(path.join(directory, "LATEST-DOWN.md")), { code: "ENOENT" });
});

test("state heartbeat is fresh, bounded, and owner-private", async (t) => {
  const directory = await fixture();
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const time = clock();
  const monitor = new RicoCommsMonitor({ directory, now: time.now, collector: async () => sample(), testMode: true });
  await monitor.run();
  const state = await readJson(directory, "state.json");
  assert.equal(Date.parse(state.expires_at_utc) - Date.parse(state.checked_at_utc), 150_000);
  for (const name of ["state.json", "MONITOR-META.json"]) {
    const stat = await fs.promises.lstat(path.join(directory, name));
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(stat.nlink, 1);
  }
});

test("permission drift, symlinks, and hard links fail closed", async (t) => {
  const directory = await fixture();
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const time = clock();
  const monitor = new RicoCommsMonitor({ directory, now: time.now, collector: async () => sample(), testMode: true });
  await monitor.run();
  await fs.promises.chmod(path.join(directory, "state.json"), 0o666);
  await assert.rejects(monitor.run(), { code: "monitor_file_mode_invalid" });
  await fs.promises.chmod(path.join(directory, "state.json"), 0o600);
  const hardLink = path.join(directory, "state-hardlink");
  await fs.promises.link(path.join(directory, "state.json"), hardLink);
  await assert.rejects(monitor.run(), { code: "monitor_file_link_count_invalid" });
});

test("cold-start outbound lastError is not a control-plane failure", async (t) => {
  const directory = await fixture();
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const time = clock();
  const collected = sample();
  collected.channel.value.channels.imessage.lastError = "outbound delivery degraded; awaiting a successful iMessage send receipt";
  collected.channel.value.channels.imessage.outboundDeliveryHealth = {
    version: 1, state: "degraded", observedAt: 0, reason: "successful_send_receipt_not_observed",
  };
  assert.equal(isColdStartOutboundLatch(collected.channel.value, collected.channel.value.channels.imessage), true);
  const monitor = new RicoCommsMonitor({ directory, now: time.now, collector: async () => collected, testMode: true });
  const result = await monitor.run();
  assert.equal(result.controlPlane, "up");
});

test("collector command surface contains only three read-only fixed commands", () => {
  assert.deepEqual(Object.keys(FIXED_COMMANDS), ["gateway", "channel", "stability"]);
  const commands = Object.values(FIXED_COMMANDS).map((args) => args.join(" "));
  assert.equal(commands.some((command) => /\b(config|restart|start|stop|send|remove|add|login|logout)\b/u.test(command)), false);
  assert.deepEqual(FIXED_COMMANDS.channel,
    ["channels", "status", "--probe", "--channel", "imessage", "--json", "--timeout", "20000"]);
});
