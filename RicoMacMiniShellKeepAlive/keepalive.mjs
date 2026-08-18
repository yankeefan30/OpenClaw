#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PROD_DIRECTORY = "/Users/alan/Documents/Codex/rico-mac-mini-shell-keepalive";
export const OPENCLAW = "/opt/homebrew/bin/openclaw";
export const CAFFEINATE = "/usr/bin/caffeinate";
export const WRITER = "ai.polar.rico-mac-mini-shell-keepalive/v1";
export const NODE_LABEL = "ai.openclaw.node";
export const CAFFEINATE_SECONDS = 360;
export const STALE_MS = 180_000;
export const FAILURES_BEFORE_RESTART = 2;
export const START_INTERVAL_SECONDS = 180;

export const FIXED_COMMANDS = Object.freeze({
  caffeinate: Object.freeze([CAFFEINATE, "-s", "-t", String(CAFFEINATE_SECONDS)]),
  nodeStatus: Object.freeze(["node", "status", "--json"]),
  nodeRestart: Object.freeze(["node", "restart", "--json"]),
});

const FORBIDDEN_OPENCLAW = Object.freeze([
  "gateway",
  "install",
  "uninstall",
  "channels",
  "send",
  "cron",
  "config",
]);

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeCode(error, fallback = "keepalive_failed") {
  const value = error?.code;
  return typeof value === "string" && /^[a-z0-9_]+$/u.test(value) ? value : fallback;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mode(stat) {
  return stat.mode & 0o777;
}

function assertOwner(stat) {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw coded("keepalive_owner_mismatch");
  }
}

function exactDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw coded("keepalive_time_invalid");
  return date;
}

function parseTimestamp(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function firstTimestamp(record, keys) {
  if (!isObject(record)) return null;
  for (const key of keys) {
    const timestamp = parseTimestamp(record[key]);
    if (timestamp !== null) return timestamp;
  }
  return null;
}

export function assertOpenClawArgs(args) {
  if (!Array.isArray(args) || args.length === 0 || args.some((part) => typeof part !== "string")) {
    throw coded("keepalive_command_invalid");
  }
  if (args.some((part) => part.includes(" ") || part.includes("/") || FORBIDDEN_OPENCLAW.includes(part))) {
    throw coded("keepalive_command_forbidden");
  }
  const allowed = [FIXED_COMMANDS.nodeStatus, FIXED_COMMANDS.nodeRestart];
  if (!allowed.some((exact) => exact.length === args.length && exact.every((part, index) => part === args[index]))) {
    throw coded("keepalive_command_forbidden");
  }
  return args;
}

export function interpretNodeStatus(payload, now, staleMs = STALE_MS) {
  const checkedAt = exactDate(now).getTime();
  if (!isObject(payload)) {
    return { installed: null, running: null, connected: null, lastSeenMs: null, stale: false, action: "unknown" };
  }

  const service = isObject(payload.service) ? payload.service : payload;
  const installed = payload.installed === false || payload.present === false || payload.ok === false && payload.error === "not_installed"
    ? false
    : payload.installed === true || payload.present === true || service.loaded === true || service.installed === true || typeof service.pid === "number" || service.running === true || payload.status === "running" || payload.status === "stopped"
      ? true
      : null;

  const running = service.running === true || payload.running === true || payload.status === "running"
    ? true
    : service.running === false || payload.running === false || payload.status === "stopped" || payload.status === "exited"
      ? false
      : null;

  const lastSeenMs = firstTimestamp(payload, ["lastSeen", "lastConnect", "lastConnectedAt", "connectedAt", "last_seen", "last_connect"])
    ?? firstTimestamp(service, ["lastSeen", "lastConnect", "lastConnectedAt", "connectedAt"]);

  const connected = payload.connected === true || service.connected === true
    ? true
    : payload.connected === false || service.connected === false
      ? false
      : lastSeenMs !== null
        ? checkedAt - lastSeenMs <= staleMs
        : null;

  const stale = connected === false || (lastSeenMs !== null && checkedAt - lastSeenMs > staleMs);
  if (installed === false) {
    return { installed: false, running: false, connected: false, lastSeenMs, stale: false, action: "missing" };
  }
  if (installed === true && (running === false || stale)) {
    return { installed: true, running: running === true, connected: connected === true, lastSeenMs, stale, action: "restart" };
  }
  if (installed === true && running === true && stale !== true) {
    return { installed: true, running: true, connected: connected !== false, lastSeenMs, stale: false, action: "healthy" };
  }
  return { installed, running, connected, lastSeenMs, stale: false, action: "unknown" };
}

class KeepAliveStore {
  constructor({ directory = PROD_DIRECTORY, now = () => new Date(), testMode = process.env.NODE_ENV === "test" } = {}) {
    this.directory = path.resolve(directory);
    this.now = now;
    this.testMode = testMode;
    if (this.directory !== PROD_DIRECTORY && !testMode) throw coded("keepalive_directory_invalid");
  }

  currentTime() {
    return exactDate(this.now());
  }

  async prepare() {
    await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.promises.stat(this.directory);
    assertOwner(stat);
    if (mode(stat) !== 0o700) await fs.promises.chmod(this.directory, 0o700);
  }

  statePath() {
    return path.join(this.directory, "state.json");
  }

  async readState() {
    try {
      const raw = await fs.promises.readFile(this.statePath(), "utf8");
      const parsed = JSON.parse(raw);
      if (!isObject(parsed)) return { consecutiveFailures: 0 };
      const failures = Number(parsed.consecutiveFailures);
      return { consecutiveFailures: Number.isInteger(failures) && failures > 0 ? failures : 0 };
    } catch (error) {
      if (error?.code === "ENOENT") return { consecutiveFailures: 0 };
      throw coded("keepalive_state_unreadable");
    }
  }

  async writeState(record) {
    const target = this.statePath();
    const temporary = `${target}.${process.pid}.tmp`;
    const body = `${JSON.stringify(record)}\n`;
    await fs.promises.writeFile(temporary, body, { mode: 0o600 });
    await fs.promises.chmod(temporary, 0o600);
    await fs.promises.rename(temporary, target);
    await fs.promises.chmod(target, 0o600);
  }
}

async function runExact(command, args, { runner, timeoutMs = 20_000 } = {}) {
  if (typeof runner === "function") {
    return runner(command, args);
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(coded("keepalive_command_timeout"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 64 * 1024) stdout = stdout.slice(0, 64 * 1024);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 8 * 1024) stderr = stderr.slice(0, 8 * 1024);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error?.code === "ENOENT" ? coded("keepalive_command_missing") : coded("keepalive_command_failed"));
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status: status ?? 1, stdout, stderr });
    });
  });
}

function parseJson(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export class RicoMacMiniShellKeepAlive {
  constructor({
    directory = PROD_DIRECTORY,
    now = () => new Date(),
    runner,
    testMode = process.env.NODE_ENV === "test",
    staleMs = STALE_MS,
  } = {}) {
    this.store = new KeepAliveStore({ directory, now, testMode });
    this.runner = runner;
    this.staleMs = staleMs;
  }

  async run() {
    await this.store.prepare();
    const now = this.store.currentTime();
    const prior = await this.store.readState();
    const reasonCodes = [];

    const sleep = await this.assertSleep();
    if (sleep !== "ok") reasonCodes.push("sleep_assertion_failed");

    const statusResult = await this.nodeStatus();
    if (statusResult.error) reasonCodes.push(statusResult.error);
    const interpreted = interpretNodeStatus(statusResult.payload, now, this.staleMs);
    if (interpreted.action === "missing") reasonCodes.push("node_service_missing");
    if (interpreted.action === "unknown" && !statusResult.error) reasonCodes.push("node_status_unparsed");
    if (interpreted.stale) reasonCodes.push("node_last_seen_stale");
    if (interpreted.running === false) reasonCodes.push("node_not_running");

    let consecutiveFailures = prior.consecutiveFailures;
    if (statusResult.error || interpreted.action === "unknown") consecutiveFailures += 1;
    else if (interpreted.action === "healthy" || interpreted.action === "restart") consecutiveFailures = 0;
    else if (interpreted.action === "missing") consecutiveFailures = 0;

    const shouldRestart = interpreted.action === "restart"
      || (interpreted.action === "unknown" && consecutiveFailures >= FAILURES_BEFORE_RESTART && interpreted.installed !== false);

    let kickstarted = false;
    if (shouldRestart) {
      const restart = await this.nodeRestart();
      kickstarted = restart.ok;
      if (!restart.ok) reasonCodes.push(restart.error ?? "node_restart_failed");
      else reasonCodes.push("node_restarted");
    }

    const node = interpreted.action === "healthy" && !kickstarted
      ? "healthy"
      : kickstarted
        ? "recovered"
        : interpreted.action === "missing"
          ? "missing"
          : interpreted.action === "restart"
            ? "down"
            : "unknown";

    const record = {
      version: 1,
      writer: WRITER,
      label: NODE_LABEL,
      checked_at_utc: now.toISOString(),
      sleep_assertion: sleep,
      node,
      kickstarted,
      consecutiveFailures,
      reason_codes: reasonCodes,
    };
    await this.store.writeState(record);
    return {
      ok: sleep === "ok" && (node === "healthy" || node === "recovered" || node === "missing"),
      sleepAssertion: sleep,
      node,
      kickstarted,
      reasonCodes,
    };
  }

  async assertSleep() {
    try {
      const result = await runExact(CAFFEINATE, FIXED_COMMANDS.caffeinate.slice(1), { runner: this.runner, timeoutMs: 8_000 });
      return result.status === 0 ? "ok" : "failed";
    } catch {
      return "failed";
    }
  }

  async nodeStatus() {
    try {
      const args = assertOpenClawArgs(FIXED_COMMANDS.nodeStatus);
      const result = await runExact(OPENCLAW, args, { runner: this.runner });
      if (result.status !== 0) {
        const payload = parseJson(result.stdout);
        if (isObject(payload) && (payload.installed === false || payload.error === "not_installed")) {
          return { payload, error: null };
        }
        return { payload, error: "node_status_failed" };
      }
      const payload = parseJson(result.stdout);
      if (!isObject(payload)) return { payload: null, error: "node_status_unparsed" };
      return { payload, error: null };
    } catch (error) {
      return { payload: null, error: safeCode(error, "node_status_failed") };
    }
  }

  async nodeRestart() {
    try {
      const args = assertOpenClawArgs(FIXED_COMMANDS.nodeRestart);
      const result = await runExact(OPENCLAW, args, { runner: this.runner });
      return result.status === 0 ? { ok: true } : { ok: false, error: "node_restart_failed" };
    } catch (error) {
      return { ok: false, error: safeCode(error, "node_restart_failed") };
    }
  }
}

async function main() {
  if (process.argv.length !== 2) throw coded("keepalive_arguments_forbidden");
  const keepalive = new RicoMacMiniShellKeepAlive();
  const result = await keepalive.run();
  process.stdout.write(`${JSON.stringify({ ok: result.ok, node: result.node, kickstarted: result.kickstarted })}\n`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
if (isMain) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: safeCode(error) })}\n`);
    process.exitCode = 1;
  }
}
