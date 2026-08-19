import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  HEALTHY_PROCTAB,
  IMSG_SEND_PROCTAB,
  WEDGED_PROCTAB,
  makeHarness,
  runHealth,
} from "./helpers.mjs";

test("hostname abort on Rico-2 does nothing", async (t) => {
  const harness = await makeHarness();
  t.after(() => fs.promises.rm(harness.dir, { recursive: true, force: true }));
  await harness.writeProctab(WEDGED_PROCTAB);
  const result = await runHealth(harness, {
    extraEnv: { MOCK_HOSTNAME: "Rico-2.local", MOCK_LOCAL_HOSTNAME: "Rico-2" },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /hostname-gate/);
  await assert.rejects(fs.promises.stat(harness.state), { code: "ENOENT" });
  assert.deepEqual(await harness.readLines("osascript.scripts"), []);
  assert.deepEqual(await harness.readLines("killed"), []);
  assert.deepEqual(await harness.readLines("imsg.args"), []);
});

test("hostname abort when LocalHostName is not Rico", async (t) => {
  const harness = await makeHarness();
  t.after(() => fs.promises.rm(harness.dir, { recursive: true, force: true }));
  await harness.writeProctab(HEALTHY_PROCTAB);
  const result = await runHealth(harness, {
    extraEnv: { MOCK_HOSTNAME: "Rico.local", MOCK_LOCAL_HOSTNAME: "Rico-2" },
  });
  assert.equal(result.code, 1);
  await assert.rejects(fs.promises.stat(harness.state), { code: "ENOENT" });
  assert.deepEqual(await harness.readLines("osascript.scripts"), []);
});

test("hostname abort on a stranger host", async (t) => {
  const harness = await makeHarness();
  t.after(() => fs.promises.rm(harness.dir, { recursive: true, force: true }));
  const result = await runHealth(harness, {
    extraEnv: { MOCK_HOSTNAME: "localhost", MOCK_LOCAL_HOSTNAME: "localhost" },
  });
  assert.equal(result.code, 1);
  assert.deepEqual(await harness.readLines("osascript.scripts"), []);
});

test("AE-success path leaves Messages running and does not relaunch", async (t) => {
  const harness = await makeHarness();
  t.after(() => fs.promises.rm(harness.dir, { recursive: true, force: true }));
  await harness.writeProctab(HEALTHY_PROCTAB);
  const result = await runHealth(harness);
  assert.equal(result.code, 0, result.stderr);
  const state = await harness.readState();
  assert.equal(state.ok, true);
  assert.equal(state.sentMessage, false);
  assert.equal(state.openclaw, "untouched");
  assert.equal(state.hostname, "Rico.local");
  assert.equal(state.localHostName, "Rico");
  assert.equal(state.aeProbe.result, "ok");
  assert.equal(state.lastAeResult, "ok");
  assert.equal(state.messages.running, true);
  assert.equal(state.messages.pid, 9037);
  assert.equal(state.imsg.version, "0.14.1");
  assert.equal(state.imsg.versionOk, true);
  assert.equal(state.imsg.runsNoSend, true);
  assert.deepEqual(state.actions, []);
  const scripts = await harness.readLines("osascript.scripts");
  assert.deepEqual(scripts, ['tell application "Messages" to get name']);
  assert.deepEqual(await harness.readLines("open.args"), []);
  assert.deepEqual(await harness.readLines("imsg.args"), ["--version"]);
});

test("AE timeout relaunches Messages and re-probes", async (t) => {
  const harness = await makeHarness();
  t.after(() => fs.promises.rm(harness.dir, { recursive: true, force: true }));
  await harness.writeProctab(HEALTHY_PROCTAB);
  await harness.setPhase("timeout");
  const result = await runHealth(harness);
  assert.equal(result.code, 0, result.stderr);
  const state = await harness.readState();
  assert.equal(state.ok, true);
  assert.equal(state.sentMessage, false);
  assert.equal(state.openclaw, "untouched");
  assert.equal(state.lastAeResult, "ok");
  assert.equal(state.aeProbe.afterRemediation, "ok");
  assert.equal(state.wedge.aeDeaf, false);
  assert.ok(state.actions.includes("relaunched_messages"));
  assert.ok(state.actions.some((action) => action.startsWith("quit_messages:")));
  const scripts = await harness.readLines("osascript.scripts");
  assert.ok(scripts.includes('tell application "Messages" to get name'));
  assert.ok(scripts.includes('tell application "Messages" to quit'));
  assert.equal(scripts.filter((line) => line.includes("get name")).length, 2);
  assert.deepEqual(await harness.readLines("open.args"), ["-g -a Messages"]);
  assert.deepEqual(await harness.readLines("imsg.args"), ["--version"]);
});

test("AE still dead after relaunch does not restart OpenClaw", async (t) => {
  const harness = await makeHarness();
  t.after(() => fs.promises.rm(harness.dir, { recursive: true, force: true }));
  await harness.writeProctab(HEALTHY_PROCTAB);
  await harness.setPhase("timeout-sticky");
  const result = await runHealth(harness);
  assert.equal(result.code, 2);
  const state = await harness.readState();
  assert.equal(state.ok, false);
  assert.equal(state.sentMessage, false);
  assert.equal(state.openclaw, "untouched");
  assert.equal(state.aeProbe.afterRemediation, "timeout");
  assert.match(state.note, /not restarting OpenClaw/);
  assert.ok(!JSON.stringify(state).includes("kickstart"));
});

test("leftover Messages osascript and imsg parent children are killed; Mail is not", async (t) => {
  const harness = await makeHarness();
  t.after(() => fs.promises.rm(harness.dir, { recursive: true, force: true }));
  await harness.writeProctab(WEDGED_PROCTAB);
  const result = await runHealth(harness);
  assert.equal(result.code, 0, result.stderr);
  const state = await harness.readState();
  const hungPids = state.hung.osascript.map((row) => row.pid).sort((a, b) => a - b);
  assert.deepEqual(hungPids, [88454, 89073]);
  assert.equal(state.hung.osascript.every((row) => row.elapsedSec >= 25), true);
  const killed = (await harness.readLines("killed")).join("\n");
  assert.match(killed, /\b88454\b/);
  assert.match(killed, /\b89073\b/);
  assert.doesNotMatch(killed, /\b555\b/);
  assert.doesNotMatch(killed, /\b12\b/);
  assert.doesNotMatch(killed, /\b9037\b/);
});

test("leftover imsg send-subcommand process is killed", async (t) => {
  const harness = await makeHarness();
  t.after(() => fs.promises.rm(harness.dir, { recursive: true, force: true }));
  await harness.writeProctab(IMSG_SEND_PROCTAB);
  const result = await runHealth(harness);
  assert.equal(result.code, 0, result.stderr);
  const state = await harness.readState();
  assert.equal(state.hung.imsgSend.length, 1);
  assert.equal(state.hung.imsgSend[0].pid, 400);
  const killed = (await harness.readLines("killed")).join("\n");
  assert.match(killed, /\b400\b/);
  assert.deepEqual(await harness.readLines("imsg.args"), ["--version"]);
});

test("dry-run AE timeout records would-relaunch and does not kill or quit", async (t) => {
  const harness = await makeHarness();
  t.after(() => fs.promises.rm(harness.dir, { recursive: true, force: true }));
  await harness.writeProctab(WEDGED_PROCTAB);
  await harness.setPhase("timeout");
  const result = await runHealth(harness, { args: ["--dry-run"] });
  assert.equal(result.code, 2);
  const state = await harness.readState();
  assert.equal(state.dryRun, true);
  assert.equal(state.sentMessage, false);
  assert.ok(state.actions.includes("would_relaunch_messages"));
  assert.ok(state.actions.some((action) => action.startsWith("would_kill_")));
  assert.equal(state.actions.some((action) => action.startsWith("kill_")), false);
  assert.deepEqual(await harness.readLines("killed"), []);
  assert.deepEqual(await harness.readLines("open.args"), []);
  const proctab = await fs.promises.readFile(harness.proctab, "utf8");
  assert.match(proctab, /Messages\.app/);
  assert.match(proctab, /88454/);
});

test("missing imsg is unhealthy even if AE is live", async (t) => {
  const harness = await makeHarness();
  t.after(() => fs.promises.rm(harness.dir, { recursive: true, force: true }));
  await harness.writeProctab(HEALTHY_PROCTAB);
  const result = await runHealth(harness, {
    extraEnv: { HEALTH_BIN_IMSG: `${harness.bin}/missing-imsg` },
  });
  assert.equal(result.code, 2);
  const state = await harness.readState();
  assert.equal(state.ok, false);
  assert.equal(state.aeProbe.result, "ok");
  assert.equal(state.imsg.present, false);
  assert.equal(state.sentMessage, false);
});

test("imsg older than 0.14.1 is unhealthy", async (t) => {
  const harness = await makeHarness();
  t.after(() => fs.promises.rm(harness.dir, { recursive: true, force: true }));
  await harness.writeProctab(HEALTHY_PROCTAB);
  const result = await runHealth(harness, { extraEnv: { MOCK_IMSG_VERSION: "0.13.0" } });
  assert.equal(result.code, 2);
  const state = await harness.readState();
  assert.equal(state.imsg.version, "0.13.0");
  assert.equal(state.imsg.versionOk, false);
  assert.equal(state.aeProbe.result, "ok");
});

test("Messages not running is launched then probed", async (t) => {
  const harness = await makeHarness();
  t.after(() => fs.promises.rm(harness.dir, { recursive: true, force: true }));
  await harness.writeProctab("");
  const result = await runHealth(harness);
  assert.equal(result.code, 0, result.stderr);
  const state = await harness.readState();
  assert.equal(state.ok, true);
  assert.ok(state.actions.includes("launched_messages"));
  assert.deepEqual(await harness.readLines("open.args"), ["-g -a Messages"]);
  assert.equal(state.messages.running, true);
  assert.equal(state.sentMessage, false);
});

test("long-lived Messages with a prior AE failure is recorded but not relaunched if AE is live", async (t) => {
  const harness = await makeHarness();
  t.after(() => fs.promises.rm(harness.dir, { recursive: true, force: true }));
  await harness.writeProctab(`9037 1 03-00:00:00 /System/Applications/Messages.app/Contents/MacOS/Messages\n`);
  await fs.promises.writeFile(harness.state, `${JSON.stringify({
    lastAeResult: "timeout",
    messages: { pid: 9037 },
  })}\n`);
  const result = await runHealth(harness);
  assert.equal(result.code, 0, result.stderr);
  const state = await harness.readState();
  assert.equal(state.ok, true);
  assert.equal(state.messages.longLived, true);
  assert.equal(state.wedge.longLivedAndLastAeFailed, true);
  assert.equal(state.wedge.aeDeaf, false);
  assert.equal(state.actions.includes("relaunched_messages"), false);
});
