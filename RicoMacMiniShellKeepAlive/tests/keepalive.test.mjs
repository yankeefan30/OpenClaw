import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CAFFEINATE,
  FAILURES_BEFORE_RESTART,
  FIXED_COMMANDS,
  OPENCLAW,
  RicoMacMiniShellKeepAlive,
  START_INTERVAL_SECONDS,
  STALE_MS,
  WRITER,
  assertOpenClawArgs,
  interpretNodeStatus,
} from "../keepalive.mjs";

function clock(initial = "2026-08-18T10:00:00.000Z") {
  let value = new Date(initial);
  return {
    now: () => new Date(value),
    advance: (milliseconds) => {
      value = new Date(value.getTime() + milliseconds);
    },
  };
}

async function fixture() {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rico-mac-mini-shell-keepalive-"));
  await fs.promises.chmod(directory, 0o700);
  return fs.promises.realpath(directory);
}

function runnerFor(statusPayload, { caffeinateStatus = 0, restartStatus = 0, statusExit = 0 } = {}) {
  const calls = [];
  const runner = async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === CAFFEINATE) {
      assert.deepEqual(args, FIXED_COMMANDS.caffeinate.slice(1));
      return { status: caffeinateStatus, stdout: "", stderr: "" };
    }
    assert.equal(command, OPENCLAW);
    if (args[1] === "status") {
      assert.deepEqual(args, [...FIXED_COMMANDS.nodeStatus]);
      return { status: statusExit, stdout: `${JSON.stringify(statusPayload)}\n`, stderr: "" };
    }
    if (args[1] === "restart") {
      assert.deepEqual(args, [...FIXED_COMMANDS.nodeRestart]);
      return { status: restartStatus, stdout: "{\"ok\":true}\n", stderr: "" };
    }
    throw new Error(`unexpected command ${command} ${args.join(" ")}`);
  };
  return { runner, calls };
}

async function readState(directory) {
  return JSON.parse(await fs.promises.readFile(path.join(directory, "state.json"), "utf8"));
}

test("caffeinate and node status are exact allowlisted commands", () => {
  assert.deepEqual(FIXED_COMMANDS.caffeinate, [CAFFEINATE, "-s", "-t", "360"]);
  assert.deepEqual(assertOpenClawArgs(["node", "status", "--json"]), ["node", "status", "--json"]);
  assert.deepEqual(assertOpenClawArgs(["node", "restart", "--json"]), ["node", "restart", "--json"]);
  assert.equal(START_INTERVAL_SECONDS, 180);
  assert.throws(() => assertOpenClawArgs(["gateway", "health", "--json"]), { code: "keepalive_command_forbidden" });
  assert.throws(() => assertOpenClawArgs(["node", "install", "--force"]), { code: "keepalive_command_forbidden" });
  assert.throws(() => assertOpenClawArgs(["channels", "status"]), { code: "keepalive_command_forbidden" });
  assert.throws(() => assertOpenClawArgs(["node", "status", "--json", "; rm -rf /"]), { code: "keepalive_command_forbidden" });
});

test("healthy node refreshes the sleep assertion and does not restart", async (t) => {
  const directory = await fixture();
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const time = clock();
  const { runner, calls } = runnerFor({
    installed: true,
    running: true,
    connected: true,
    lastSeen: time.now().toISOString(),
  });
  const result = await new RicoMacMiniShellKeepAlive({
    directory,
    now: time.now,
    runner,
    testMode: true,
  }).run();
  assert.equal(result.ok, true);
  assert.equal(result.sleepAssertion, "ok");
  assert.equal(result.node, "healthy");
  assert.equal(result.kickstarted, false);
  assert.equal(calls.filter((call) => call.args[1] === "restart").length, 0);
  const state = await readState(directory);
  assert.equal(state.writer, WRITER);
  assert.equal(await fs.promises.stat(directory).then((stat) => stat.mode & 0o777), 0o700);
  assert.equal(await fs.promises.stat(path.join(directory, "state.json")).then((stat) => stat.mode & 0o777), 0o600);
  assert.equal(JSON.stringify(state).includes("token"), false);
});

test("stale last-seen restarts only the node service", async (t) => {
  const directory = await fixture();
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const time = clock();
  const stale = new Date(time.now().getTime() - STALE_MS - 1_000).toISOString();
  const { runner, calls } = runnerFor({ installed: true, running: true, lastSeen: stale });
  const result = await new RicoMacMiniShellKeepAlive({
    directory,
    now: time.now,
    runner,
    testMode: true,
  }).run();
  assert.equal(result.node, "recovered");
  assert.equal(result.kickstarted, true);
  assert.deepEqual(calls.at(-1), { command: OPENCLAW, args: ["node", "restart", "--json"] });
  assert.equal(calls.some((call) => call.args.includes("gateway")), false);
});

test("stopped but installed node is restarted once", async (t) => {
  const directory = await fixture();
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const { runner, calls } = runnerFor({ installed: true, running: false, status: "stopped" });
  const result = await new RicoMacMiniShellKeepAlive({
    directory,
    now: clock().now,
    runner,
    testMode: true,
  }).run();
  assert.equal(result.kickstarted, true);
  assert.equal(result.node, "recovered");
  assert.equal(calls.filter((call) => call.args[1] === "restart").length, 1);
});

test("missing node service is recorded and never installed", async (t) => {
  const directory = await fixture();
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const { runner, calls } = runnerFor({ installed: false, error: "not_installed" }, { statusExit: 1 });
  const result = await new RicoMacMiniShellKeepAlive({
    directory,
    now: clock().now,
    runner,
    testMode: true,
  }).run();
  assert.equal(result.node, "missing");
  assert.equal(result.kickstarted, false);
  assert.equal(result.reasonCodes.includes("node_service_missing"), true);
  assert.equal(calls.some((call) => call.args.includes("install") || call.args[1] === "restart"), false);
});

test("unknown status restarts only after consecutive failures", async (t) => {
  const directory = await fixture();
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const time = clock();
  const { runner, calls } = runnerFor({}, { statusExit: 1 });
  const keepalive = new RicoMacMiniShellKeepAlive({
    directory,
    now: time.now,
    runner,
    testMode: true,
  });
  for (let index = 0; index < FAILURES_BEFORE_RESTART - 1; index += 1) {
    const result = await keepalive.run();
    assert.equal(result.kickstarted, false);
    time.advance(180_000);
  }
  const recovered = await keepalive.run();
  assert.equal(recovered.kickstarted, true);
  assert.equal(calls.filter((call) => call.args[1] === "restart").length, 1);
});

test("interpretNodeStatus treats a connected zombie as restartable", () => {
  const now = new Date("2026-08-18T10:00:00.000Z");
  assert.equal(interpretNodeStatus({ running: true, connected: false }, now).action, "restart");
  assert.equal(interpretNodeStatus({ installed: true, running: true, lastSeen: now.toISOString() }, now).action, "healthy");
  assert.equal(interpretNodeStatus({ installed: false }, now).action, "missing");
  assert.equal(interpretNodeStatus(null, now).action, "unknown");
});
