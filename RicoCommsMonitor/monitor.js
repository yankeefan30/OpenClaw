#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PROD_DIRECTORY = "/Users/alan/Documents/Codex/rico-comms-monitor";
export const OPENCLAW = "/opt/homebrew/bin/openclaw";
export const WRITER = "ai.polar.rico-comms-monitor/v1";
export const FIXED_COMMANDS = Object.freeze({
  gateway: Object.freeze(["gateway", "health", "--json", "--timeout", "20000"]),
  channel: Object.freeze(["channels", "status", "--probe", "--channel", "imessage", "--json", "--timeout", "20000"]),
  stability: Object.freeze(["gateway", "stability", "--json", "--limit", "25", "--timeout", "20000"]),
});

const FILES = Object.freeze({
  state: Object.freeze({ name: "state.json", maxBytes: 64 * 1024 }),
  meta: Object.freeze({ name: "MONITOR-META.json", maxBytes: 16 * 1024 }),
  alert: Object.freeze({ name: "ALERT.json", maxBytes: 16 * 1024 }),
  latest: Object.freeze({ name: "LATEST-DOWN.md", maxBytes: 64 * 1024 }),
});
const LOCK_STALE_MS = 5 * 60 * 1000;
const CONTROL_FAILURE_THRESHOLD = 3;
const CONTROL_RECOVERY_THRESHOLD = 2;
const DELIVERY_CONFIRMATION_THRESHOLD = 2;
const DELIVERY_RECENT_MS = 10 * 60 * 1000;
const HEARTBEAT_TTL_MS = 150 * 1000;

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeCode(error, fallback = "monitor_failed") {
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
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw coded("monitor_owner_mismatch");
}

function exactDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw coded("monitor_time_invalid");
  return date;
}

function safeIsoFromMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return new Date(number).toISOString();
}

function stableHash(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 24);
}

export class MonitorStore {
  constructor({ directory = PROD_DIRECTORY, now = () => new Date(), testMode = process.env.NODE_ENV === "test" } = {}) {
    this.directory = path.resolve(directory);
    this.now = now;
    this.testMode = testMode;
    if (this.directory !== PROD_DIRECTORY && !testMode) throw coded("monitor_directory_invalid");
  }

  currentTime() {
    return exactDate(this.now());
  }

  file(kind) {
    const spec = FILES[kind];
    if (!spec) throw coded("monitor_file_kind_invalid");
    const value = path.join(this.directory, spec.name);
    if (path.dirname(value) !== this.directory) throw coded("monitor_path_escape");
    return value;
  }

  async assertDirectory() {
    let stat;
    try {
      stat = await fs.promises.lstat(this.directory);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await fs.promises.mkdir(this.directory, { mode: 0o700 });
      stat = await fs.promises.lstat(this.directory);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw coded("monitor_directory_invalid");
    assertOwner(stat);
    if (await fs.promises.realpath(this.directory) !== this.directory) throw coded("monitor_directory_realpath_mismatch");
    if (mode(stat) === 0o755) {
      await fs.promises.chmod(this.directory, 0o700);
      stat = await fs.promises.lstat(this.directory);
    }
    if (mode(stat) !== 0o700) throw coded("monitor_directory_mode_invalid");
    return stat;
  }

  async secureExisting(kind, { missing = false, hardenLegacy = true } = {}) {
    await this.assertDirectory();
    const target = this.file(kind);
    let before;
    try {
      before = await fs.promises.lstat(target);
    } catch (error) {
      if (missing && error?.code === "ENOENT") return null;
      throw error;
    }
    if (!before.isFile() || before.isSymbolicLink()) throw coded("monitor_file_not_regular");
    if (before.nlink !== 1) throw coded("monitor_file_link_count_invalid");
    assertOwner(before);
    if (before.size > FILES[kind].maxBytes) throw coded("monitor_file_too_large");
    if (await fs.promises.realpath(target) !== target) throw coded("monitor_file_realpath_mismatch");
    if (mode(before) === 0o600) return before;
    if (!hardenLegacy || mode(before) !== 0o644) throw coded("monitor_file_mode_invalid");
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_CLOEXEC ?? 0);
    const handle = await fs.promises.open(target, flags);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw coded("monitor_file_changed_during_open");
      }
      assertOwner(opened);
      if (mode(opened) !== 0o644 || opened.size > FILES[kind].maxBytes) throw coded("monitor_file_mode_invalid");
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const current = await fs.promises.lstat(target);
    if (current.dev !== before.dev || current.ino !== before.ino || mode(current) !== 0o600) {
      throw coded("monitor_file_hardening_failed");
    }
    return current;
  }

  async readStable(kind, { missing = false } = {}) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await this.secureExisting(kind, { missing });
      if (before === null) return null;
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_CLOEXEC ?? 0);
      const handle = await fs.promises.open(this.file(kind), flags);
      let opened;
      let after;
      let payload;
      try {
        opened = await handle.stat();
        if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
          throw coded("monitor_file_changed_during_open");
        }
        payload = await handle.readFile();
        after = await handle.stat();
      } finally {
        await handle.close();
      }
      const current = await this.secureExisting(kind);
      if (current.dev !== opened.dev || current.ino !== opened.ino || current.size !== opened.size ||
          after.size !== opened.size || payload.byteLength !== opened.size ||
          current.mtimeMs !== opened.mtimeMs || after.mtimeMs !== opened.mtimeMs ||
          current.ctimeMs !== opened.ctimeMs || after.ctimeMs !== opened.ctimeMs) continue;
      return { payload, stat: current };
    }
    throw coded("monitor_file_changed_during_read");
  }

  async readJson(kind) {
    const read = await this.readStable(kind, { missing: true });
    if (read === null) return null;
    try {
      return { value: JSON.parse(read.payload.toString("utf8")), stat: read.stat };
    } catch {
      throw coded("monitor_json_invalid");
    }
  }

  async writeAtomic(kind, value) {
    await this.assertDirectory();
    const target = this.file(kind);
    const payload = Buffer.from(typeof value === "string" ? value : `${JSON.stringify(value)}\n`, "utf8");
    if (payload.byteLength > FILES[kind].maxBytes) throw coded("monitor_file_too_large");
    const before = await this.secureExisting(kind, { missing: true });
    const temp = path.join(this.directory, `.monitor-${kind}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_CLOEXEC ?? 0);
    let handle;
    try {
      handle = await fs.promises.open(temp, flags, 0o600);
      await handle.writeFile(payload);
      await handle.sync();
      await handle.close();
      handle = null;
      const current = await this.secureExisting(kind, { missing: true });
      const same = (before === null && current === null) || (before !== null && current !== null &&
        before.dev === current.dev && before.ino === current.ino && before.size === current.size &&
        before.mtimeMs === current.mtimeMs && before.ctimeMs === current.ctimeMs);
      if (!same) throw coded("monitor_file_changed_before_replace");
      await fs.promises.rename(temp, target);
      await this.secureExisting(kind, { hardenLegacy: false });
      const directoryHandle = await fs.promises.open(this.directory, fs.constants.O_RDONLY);
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await fs.promises.unlink(temp).catch(() => {});
      throw error;
    }
  }

  async ensureArchiveDirectory() {
    const archive = path.join(this.directory, "incidents");
    if (path.dirname(archive) !== this.directory) throw coded("monitor_archive_path_invalid");
    let stat;
    try {
      stat = await fs.promises.lstat(archive);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await fs.promises.mkdir(archive, { mode: 0o700 });
      stat = await fs.promises.lstat(archive);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || mode(stat) !== 0o700) throw coded("monitor_archive_invalid");
    assertOwner(stat);
    if (await fs.promises.realpath(archive) !== archive) throw coded("monitor_archive_invalid");
    return archive;
  }

  async archive(kind, reason) {
    const current = await this.secureExisting(kind, { missing: true });
    if (current === null) return { status: "absent" };
    const archive = await this.ensureArchiveDirectory();
    const stamp = this.currentTime().toISOString().replace(/[-:.]/gu, "");
    const suffix = crypto.randomBytes(6).toString("hex");
    const destination = path.join(archive, `${stamp}-${reason}-${suffix}-${FILES[kind].name}`);
    if (path.dirname(destination) !== archive) throw coded("monitor_archive_path_invalid");
    const verify = await this.secureExisting(kind);
    if (verify.dev !== current.dev || verify.ino !== current.ino) throw coded("monitor_file_changed_before_archive");
    await fs.promises.rename(this.file(kind), destination);
    const archived = await fs.promises.lstat(destination);
    if (!archived.isFile() || archived.isSymbolicLink() || archived.nlink !== 1 || mode(archived) !== 0o600) {
      throw coded("monitor_archive_invalid");
    }
    return { status: "archived" };
  }

  async acquireLock() {
    await this.assertDirectory();
    const lock = path.join(this.directory, ".monitor.lock");
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_CLOEXEC ?? 0);
    const create = async () => {
      const handle = await fs.promises.open(lock, flags, 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, created_at_utc: this.currentTime().toISOString() })}\n`);
        await handle.sync();
        const stat = await handle.stat();
        return { dev: stat.dev, ino: stat.ino };
      } finally {
        await handle.close();
      }
    };
    let acquired;
    try {
      acquired = await create();
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const stat = await fs.promises.lstat(lock);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || mode(stat) !== 0o600) {
        throw coded("monitor_lock_invalid");
      }
      assertOwner(stat);
      if (this.currentTime().getTime() - stat.mtimeMs <= LOCK_STALE_MS) throw coded("monitor_busy");
      const current = await fs.promises.lstat(lock);
      if (current.dev !== stat.dev || current.ino !== stat.ino) throw coded("monitor_lock_changed");
      await fs.promises.unlink(lock);
      acquired = await create();
    }
    return async () => {
      const current = await fs.promises.lstat(lock);
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || mode(current) !== 0o600 ||
          current.dev !== acquired.dev || current.ino !== acquired.ino) throw coded("monitor_lock_changed");
      assertOwner(current);
      await fs.promises.unlink(lock);
    };
  }
}

async function runJson(args, { timeoutMs = 25_000, maxBytes = 512 * 1024 } = {}) {
  if (!Object.values(FIXED_COMMANDS).some((allowed) => allowed.length === args.length &&
      allowed.every((value, index) => value === args[index]))) throw coded("collector_command_not_allowed");
  return new Promise((resolve) => {
    const child = spawn(OPENCLAW, args, {
      cwd: "/Users/alan/OpenClawStudio/RicoCommsMonitor",
      env: {
        HOME: "/Users/alan",
        LANG: "C",
        PATH: "/opt/homebrew/bin:/usr/bin:/bin",
        NO_COLOR: "1",
        OPENCLAW_NO_UPDATE_CHECK: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      finish({ ok: false, code: "collector_timeout" });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        child.kill("SIGKILL");
        finish({ ok: false, code: "collector_output_too_large" });
      } else {
        chunks.push(chunk);
      }
    });
    child.on("error", () => finish({ ok: false, code: "collector_spawn_failed" }));
    child.on("close", (status, signal) => {
      if (settled) return;
      if (signal || status !== 0) return finish({ ok: false, code: "collector_exit_nonzero" });
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        finish({ ok: true, value });
      } catch {
        finish({ ok: false, code: "collector_json_invalid" });
      }
    });
  });
}

export async function collectReadOnly() {
  // Run one heavyweight CLI at a time. Launchd background processes receive a
  // lower scheduling priority; concurrent OpenClaw startups can otherwise time
  // out together and produce a false UNKNOWN sample.
  const gateway = await runJson(FIXED_COMMANDS.gateway);
  const channel = await runJson(FIXED_COMMANDS.channel);
  const stability = await runJson(FIXED_COMMANDS.stability);
  return { gateway, channel, stability, commands: FIXED_COMMANDS };
}

function normalizePrevious(value) {
  if (!isObject(value)) return { controlStatus: "unknown", consecutiveFailures: 0, consecutiveSuccesses: 0,
    deliveryCandidateHash: null, deliveryConfirmations: 0, lastTransitionAt: null, lastAlertHash: null };
  if (value.version === 2 && value.writer === WRITER) {
    return {
      controlStatus: value.control_plane?.status ?? "unknown",
      consecutiveFailures: Number(value.control_plane?.consecutive_failures) || 0,
      consecutiveSuccesses: Number(value.control_plane?.consecutive_successes) || 0,
      deliveryCandidateHash: value.delivery?.candidate_hash ?? null,
      deliveryConfirmations: Number(value.delivery?.confirmation_count) || 0,
      lastTransitionAt: value.transitions?.last_control_transition_at ?? null,
      lastAlertHash: value.alert?.last_emitted_hash ?? null,
    };
  }
  return {
    controlStatus: value.last_status === "up" ? "up" : value.last_status === "down" ? "down" : "unknown",
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    deliveryCandidateHash: null,
    deliveryConfirmations: 0,
    lastTransitionAt: null,
    lastAlertHash: null,
  };
}

const COLD_START_LAST_ERROR = "outbound delivery degraded; awaiting a successful iMessage send receipt";

export function isColdStartOutboundLatch(channelRoot, channel) {
  const defaultId = channelRoot?.channelDefaultAccountId?.imessage || "default";
  const accounts = Array.isArray(channelRoot?.channelAccounts?.imessage) ? channelRoot.channelAccounts.imessage : [];
  const account = accounts.find((item) => isObject(item) && item.accountId === defaultId) ?? accounts[0];
  const health = (isObject(channel?.outboundDeliveryHealth) ? channel.outboundDeliveryHealth : null)
    || (isObject(account?.outboundDeliveryHealth) ? account.outboundDeliveryHealth : null);
  if (!isObject(health)) return false;
  const lastError = channel?.lastError ?? account?.lastError;
  return health.version === 1
    && health.state === "degraded"
    && health.reason === "successful_send_receipt_not_observed"
    && Number(health.observedAt) === 0
    && String(lastError ?? "") === COLD_START_LAST_ERROR;
}

function analyze(collected, previous, now) {
  const reasons = [];
  const gatewayValue = collected.gateway.ok && isObject(collected.gateway.value) ? collected.gateway.value : null;
  const channelRoot = collected.channel.ok && isObject(collected.channel.value) ? collected.channel.value : null;
  const channel = channelRoot?.channels?.imessage;
  if (!collected.gateway.ok) reasons.push(collected.gateway.code ?? "gateway_collect_failed");
  else if (gatewayValue?.ok !== true) reasons.push("gateway_unhealthy");
  if (!collected.channel.ok) reasons.push(collected.channel.code ?? "channel_collect_failed");
  else if (!isObject(channel)) reasons.push("channel_missing");
  else {
    if (channel.configured !== true) reasons.push("channel_not_configured");
    if (channel.running !== true) reasons.push("channel_not_running");
    if (channel.probe?.ok !== true) reasons.push("channel_probe_failed");
    if (channel.lastError !== null && channel.lastError !== undefined && String(channel.lastError).length > 0
      && !isColdStartOutboundLatch(channelRoot, channel)) {
      reasons.push("channel_last_error");
    }
  }
  const directSuccess = reasons.length === 0;
  const consecutiveFailures = directSuccess ? 0 : previous.consecutiveFailures + 1;
  const consecutiveSuccesses = directSuccess ? previous.consecutiveSuccesses + 1 : 0;
  let controlStatus;
  if (!directSuccess) {
    // Hold the last directly-confirmed UP state during the two-sample
    // debounce window. The failed sample and counter remain explicit, while a
    // cold-start monitor stays UNKNOWN until it gets a successful observation.
    controlStatus = consecutiveFailures >= CONTROL_FAILURE_THRESHOLD ? "down"
      : previous.controlStatus === "up" ? "up" : "unknown";
  } else if (previous.controlStatus === "down" && consecutiveSuccesses < CONTROL_RECOVERY_THRESHOLD) {
    controlStatus = "recovering";
  } else {
    controlStatus = "up";
  }

  const failedQueues = Array.isArray(gatewayValue?.deliveryQueues?.failed) ? gatewayValue.deliveryQueues.failed : [];
  const outboundFailure = failedQueues.find((item) => isObject(item) && item.queueName === "outbound");
  const deadLettered = Math.max(0, Math.floor(Number(outboundFailure?.count) || 0));
  const events = collected.stability.ok && Array.isArray(collected.stability.value?.events)
    ? collected.stability.value.events : [];
  const recentErrors = events.filter((event) => isObject(event) && event.type === "message.delivery.error" &&
    event.channel === "imessage" && Number.isFinite(Number(event.ts)) &&
    now.getTime() - Number(event.ts) >= 0 && now.getTime() - Number(event.ts) <= DELIVERY_RECENT_MS)
    .sort((left, right) => Number(right.ts) - Number(left.ts));
  const recent = recentErrors[0] ?? null;
  const recentAt = recent ? safeIsoFromMs(recent.ts) : null;
  const candidateHash = recent ? stableHash(`${recent.ts}|imessage|${recent.deliveryKind ?? "unknown"}|${recent.outcome ?? "error"}`) : null;
  const confirmations = candidateHash === null ? 0 : candidateHash === previous.deliveryCandidateHash
    ? previous.deliveryConfirmations + 1 : 1;
  const deliveryStatus = deadLettered > 0 || recent !== null ? "degraded" : collected.stability.ok ? "healthy" : "unknown";
  const runtimeStatus = gatewayValue?.eventLoop?.degraded === true ? "degraded" : "healthy";
  const overallStatus = controlStatus === "down" ? "down"
    : controlStatus === "unknown" || controlStatus === "recovering" ? controlStatus
      : deliveryStatus === "degraded" || runtimeStatus === "degraded" ? "degraded" : "up";
  const controlTransition = controlStatus !== previous.controlStatus;
  const controlPage = controlStatus === "down" && previous.controlStatus !== "down";
  const deliveryConfirmed = candidateHash !== null && confirmations >= DELIVERY_CONFIRMATION_THRESHOLD && deadLettered > 0;
  const deliveryPage = deliveryConfirmed && candidateHash !== previous.lastAlertHash;
  const alertType = controlPage ? "control_plane_down" : deliveryPage ? "delivery_degraded" : null;
  const alertHash = controlPage ? stableHash(`control_plane_down|${reasons.join(",")}`)
    : deliveryPage ? candidateHash : previous.lastAlertHash;
  return {
    state: {
      version: 2,
      writer: WRITER,
      checked_at_utc: now.toISOString(),
      expires_at_utc: new Date(now.getTime() + HEARTBEAT_TTL_MS).toISOString(),
      overall_status: overallStatus,
      control_plane: {
        status: controlStatus,
        direct_probe_ok: directSuccess,
        gateway_ok: gatewayValue?.ok === true,
        configured: channel?.configured === true,
        running: channel?.running === true,
        probe_ok: channel?.probe?.ok === true,
        private_api_available: channel?.probe?.privateApi?.available === true,
        expected_sip_limited: channel?.probe?.ok === true && channel?.probe?.privateApi?.available !== true,
        reason_codes: reasons.slice(0, 8),
        consecutive_failures: consecutiveFailures,
        consecutive_successes: consecutiveSuccesses,
      },
      delivery: {
        status: deliveryStatus,
        dead_lettered_outbound: deadLettered,
        recent_error_at_utc: recentAt,
        candidate_hash: candidateHash,
        confirmation_count: confirmations,
      },
      gateway_runtime: { status: runtimeStatus },
      transitions: {
        last_control_transition_at: controlTransition ? now.toISOString() : previous.lastTransitionAt,
      },
      alert: {
        emitted_this_run: alertType !== null,
        type: alertType,
        last_emitted_hash: alertHash,
      },
    },
    directSuccess,
    controlTransition,
    alertType,
    alertHash,
  };
}

function downMarkdown(state) {
  return [
    "# Rico Communications DOWN",
    "",
    `Captured: ${state.checked_at_utc}`,
    "",
    "## Direct read-only probe",
    `- gateway_ok: ${state.control_plane.gateway_ok}`,
    `- configured: ${state.control_plane.configured}`,
    `- running: ${state.control_plane.running}`,
    `- probe_ok: ${state.control_plane.probe_ok}`,
    `- consecutive_failures: ${state.control_plane.consecutive_failures}`,
    `- reason_codes: ${state.control_plane.reason_codes.join(", ") || "none"}`,
    "",
    "The collector cannot change configuration, restart services, send channel messages, or alter model policy.",
    "",
  ].join("\n");
}

export class RicoCommsMonitor {
  constructor({
    directory = PROD_DIRECTORY,
    now = () => new Date(),
    collector = collectReadOnly,
    testMode = process.env.NODE_ENV === "test",
  } = {}) {
    this.now = now;
    this.collector = collector;
    this.store = new MonitorStore({ directory, now, testMode });
  }

  async run() {
    const release = await this.store.acquireLock();
    try {
      const priorRead = await this.store.readJson("state");
      const metaRead = await this.store.readJson("meta");
      const priorValue = priorRead?.value ?? null;
      const previous = normalizePrevious(priorValue);
      const previousMeta = isObject(metaRead?.value) && metaRead.value.version === 1
        ? metaRead.value : { version: 1, generation: 0, writer_conflicts: 0, last_writer_conflict_at_utc: null };
      const writerConflict = previousMeta.generation > 0 && priorValue?.writer !== WRITER;
      const collected = await this.collector();
      // Timestamp the completed observation, rather than the start of a slow
      // CLI collection, so each successful write gets the full heartbeat TTL.
      const now = exactDate(this.now());
      const analyzed = analyze(collected, previous, now);
      analyzed.state.monitor = {
        generation: Number(previousMeta.generation) + 1,
        writer_conflicts: Number(previousMeta.writer_conflicts) + (writerConflict ? 1 : 0),
        writer_conflict_this_run: writerConflict,
      };

      // A DOWN incident is cleared only by a successful direct observation.
      // A collector timeout or the first recovery sample cannot erase it.
      if (analyzed.directSuccess && analyzed.state.control_plane.status === "up") {
        await this.store.archive("latest", "cleared");
      }
      if (analyzed.directSuccess && analyzed.alertType === null && analyzed.state.control_plane.status === "up" &&
          analyzed.state.delivery.recent_error_at_utc === null) {
        await this.store.archive("alert", "cleared");
      }

      await this.store.writeAtomic("state", analyzed.state);
      await this.store.writeAtomic("meta", {
        version: 1,
        writer: WRITER,
        generation: analyzed.state.monitor.generation,
        writer_conflicts: analyzed.state.monitor.writer_conflicts,
        last_writer_conflict_at_utc: writerConflict ? now.toISOString()
          : previousMeta.last_writer_conflict_at_utc ?? null,
        updated_at_utc: now.toISOString(),
      });

      if (analyzed.state.control_plane.status === "down") {
        await this.store.writeAtomic("latest", downMarkdown(analyzed.state));
      }
      if (analyzed.alertType !== null) {
        await this.store.writeAtomic("alert", {
          version: 1,
          status: "pending",
          type: analyzed.alertType,
          dedupe_hash: analyzed.alertHash,
          created_at_utc: now.toISOString(),
          control_plane_status: analyzed.state.control_plane.status,
          delivery_status: analyzed.state.delivery.status,
          reason_codes: analyzed.state.control_plane.reason_codes,
          notification_sent: false,
        });
      }
      return {
        status: analyzed.state.overall_status,
        controlPlane: analyzed.state.control_plane.status,
        delivery: analyzed.state.delivery.status,
        alertCreated: analyzed.alertType !== null,
        stateFreshUntil: analyzed.state.expires_at_utc,
      };
    } finally {
      await release();
    }
  }
}

async function main() {
  if (process.argv.length !== 2) throw coded("monitor_arguments_forbidden");
  const monitor = new RicoCommsMonitor();
  const result = await monitor.run();
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
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
