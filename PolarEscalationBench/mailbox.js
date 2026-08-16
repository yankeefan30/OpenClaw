#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DIRECTORY, PolarEscalationBench, REQUEST_ID_PATTERN } from "./bench.js";

const FILES = Object.freeze({
  dispatch: Object.freeze({ name: "DISPATCH.json", maxBytes: 32 * 1024 }),
  result: Object.freeze({ name: "RESULT.json", maxBytes: 32 * 1024 }),
  status: Object.freeze({ name: "MAILBOX-STATUS.json", maxBytes: 8 * 1024 }),
});
const LOCK_STALE_MS = 5 * 60 * 1000;
const RENEW_AHEAD_MS = 5 * 60 * 1000;
const MAX_DISPATCH_AGE_MS = 2 * 60 * 60 * 1000;

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function mode(stat) {
  return stat.mode & 0o777;
}

function assertOwner(stat) {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw coded("mailbox_owner_mismatch");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactIso(value, code) {
  const text = String(value ?? "").trim();
  const date = new Date(text);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== text) throw coded(code);
  return text;
}

function exactRequestId(value) {
  const text = String(value ?? "").trim();
  if (!REQUEST_ID_PATTERN.test(text)) throw coded("mailbox_request_id_invalid");
  return text;
}

function exactToken(value) {
  const text = String(value ?? "").trim();
  if (!/^[a-f0-9]{64}$/u.test(text)) throw coded("mailbox_claim_token_invalid");
  return text;
}

function safeError(error) {
  return typeof error?.code === "string" && /^[a-z0-9_]+$/u.test(error.code) ? error.code : "mailbox_failed";
}

export class PolarEscalationMailbox {
  constructor({
    directory = DEFAULT_DIRECTORY,
    bench = null,
    now = () => new Date(),
    randomBytes = crypto.randomBytes,
    testMode = process.env.NODE_ENV === "test",
  } = {}) {
    this.directory = path.resolve(directory);
    this.now = now;
    this.randomBytes = randomBytes;
    this.testMode = testMode;
    if (this.directory !== DEFAULT_DIRECTORY && !testMode) throw coded("mailbox_directory_invalid");
    this.bench = bench ?? new PolarEscalationBench({ directory: this.directory, now, randomBytes, testMode });
  }

  currentTime() {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw coded("mailbox_time_invalid");
    return value;
  }

  filePath(kind) {
    const spec = FILES[kind];
    if (!spec) throw coded("mailbox_file_kind_invalid");
    const value = path.join(this.directory, spec.name);
    if (path.dirname(value) !== this.directory) throw coded("mailbox_path_escape");
    return value;
  }

  async checkedStat(kind, { missing = false } = {}) {
    await this.bench.assertDirectory();
    const file = this.filePath(kind);
    let stat;
    try {
      stat = await fs.promises.lstat(file);
    } catch (error) {
      if (missing && error?.code === "ENOENT") return null;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) throw coded("mailbox_file_not_regular");
    if (stat.nlink !== 1) throw coded("mailbox_file_link_count_invalid");
    assertOwner(stat);
    if (mode(stat) !== 0o600) throw coded("mailbox_file_mode_invalid");
    if (stat.size > FILES[kind].maxBytes) throw coded("mailbox_file_too_large");
    if (await fs.promises.realpath(file) !== file) throw coded("mailbox_file_realpath_mismatch");
    return stat;
  }

  async hardenResultDrop() {
    await this.bench.assertDirectory();
    const file = this.filePath("result");
    let before;
    try {
      before = await fs.promises.lstat(file);
    } catch (error) {
      if (error?.code === "ENOENT") return { status: "missing" };
      throw error;
    }
    if (before.isSymbolicLink() || !before.isFile()) throw coded("mailbox_file_not_regular");
    if (before.nlink !== 1) throw coded("mailbox_file_link_count_invalid");
    assertOwner(before);
    if (before.size > FILES.result.maxBytes) throw coded("mailbox_file_too_large");
    if (await fs.promises.realpath(file) !== file) throw coded("mailbox_file_realpath_mismatch");
    if (mode(before) === 0o600) return { status: "private" };
    // Grok Bot's native writer atomically recreates an owner file as 0644. The
    // parent directory is already owner-only 0700, so no other user can reach
    // the file. Harden the exact opened inode before reading a single byte.
    if (mode(before) !== 0o644) throw coded("mailbox_file_mode_invalid");
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_CLOEXEC ?? 0);
    const handle = await fs.promises.open(file, flags);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw coded("mailbox_file_changed_during_open");
      }
      assertOwner(opened);
      if (mode(opened) !== 0o644 || opened.size > FILES.result.maxBytes) throw coded("mailbox_file_mode_invalid");
      await handle.chmod(0o600);
      await handle.sync();
      const hardened = await handle.stat();
      if (hardened.dev !== opened.dev || hardened.ino !== opened.ino || mode(hardened) !== 0o600) {
        throw coded("mailbox_file_hardening_failed");
      }
    } finally {
      await handle.close();
    }
    const current = await this.checkedStat("result");
    if (current.dev !== before.dev || current.ino !== before.ino) throw coded("mailbox_file_changed_after_hardening");
    return { status: "hardened" };
  }

  async createFile(kind, value) {
    const target = this.filePath(kind);
    const payload = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    if (payload.byteLength > FILES[kind].maxBytes) throw coded("mailbox_file_too_large");
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_CLOEXEC ?? 0);
    const handle = await fs.promises.open(target, flags, 0o600);
    try {
      await handle.writeFile(payload);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.checkedStat(kind);
  }

  async ensureFiles() {
    const now = this.currentTime().toISOString();
    const initial = {
      dispatch: { version: 1, status: "idle", updated_at_utc: now },
      result: { version: 1, status: "empty" },
      status: { version: 1, status: "ready", updated_at_utc: now },
    };
    for (const kind of Object.keys(FILES)) {
      const existing = await this.checkedStat(kind, { missing: true });
      if (existing === null) {
        try {
          await this.createFile(kind, initial[kind]);
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
          await this.checkedStat(kind);
        }
      }
    }
  }

  async readStable(kind) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await this.checkedStat(kind);
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_CLOEXEC ?? 0);
      const handle = await fs.promises.open(this.filePath(kind), flags);
      let opened;
      let after;
      let payload;
      try {
        opened = await handle.stat();
        if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
          throw coded("mailbox_file_changed_during_open");
        }
        assertOwner(opened);
        if (mode(opened) !== 0o600 || opened.size > FILES[kind].maxBytes) throw coded("mailbox_file_invalid");
        payload = await handle.readFile();
        after = await handle.stat();
      } finally {
        await handle.close();
      }
      const current = await this.checkedStat(kind);
      const stable = after.dev === opened.dev && after.ino === opened.ino &&
        current.dev === opened.dev && current.ino === opened.ino &&
        after.size === opened.size && current.size === opened.size && payload.byteLength === opened.size &&
        after.mtimeMs === opened.mtimeMs && current.mtimeMs === opened.mtimeMs &&
        after.ctimeMs === opened.ctimeMs && current.ctimeMs === opened.ctimeMs;
      if (!stable) continue;
      let value;
      try {
        value = JSON.parse(payload.toString("utf8"));
      } catch {
        throw coded("mailbox_json_invalid");
      }
      return { value, stat: current };
    }
    throw coded("mailbox_file_changed_during_read");
  }

  async writeAtomic(kind, value, expectedStat = null) {
    await this.bench.assertDirectory();
    const target = this.filePath(kind);
    const payload = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    if (payload.byteLength > FILES[kind].maxBytes) throw coded("mailbox_file_too_large");
    const before = await this.checkedStat(kind);
    if (expectedStat && (before.dev !== expectedStat.dev || before.ino !== expectedStat.ino ||
      before.size !== expectedStat.size || before.mtimeMs !== expectedStat.mtimeMs || before.ctimeMs !== expectedStat.ctimeMs)) {
      throw coded("mailbox_file_changed_before_replace");
    }
    const temp = path.join(this.directory, `.mailbox-${kind}.${process.pid}.${this.randomBytes(8).toString("hex")}.tmp`);
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_CLOEXEC ?? 0);
    let handle;
    try {
      handle = await fs.promises.open(temp, flags, 0o600);
      await handle.writeFile(payload);
      await handle.sync();
      await handle.close();
      handle = null;
      const current = await this.checkedStat(kind);
      if (current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size ||
        current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) {
        throw coded("mailbox_file_changed_before_replace");
      }
      await fs.promises.rename(temp, target);
      await this.checkedStat(kind);
      const directoryHandle = await fs.promises.open(this.directory, fs.constants.O_RDONLY);
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await fs.promises.unlink(temp).catch(() => {});
      throw error;
    }
  }

  parseDispatch(value) {
    if (!isObject(value) || value.version !== 1) throw coded("mailbox_dispatch_invalid");
    if (value.status === "idle") return Object.freeze({ status: "idle" });
    if (value.status !== "claimed" || !isObject(value.request)) throw coded("mailbox_dispatch_invalid");
    const requestId = exactRequestId(value.requestId);
    if (exactRequestId(value.request.requestId) !== requestId) throw coded("mailbox_dispatch_invalid");
    return Object.freeze({
      status: "claimed",
      requestId,
      claimToken: exactToken(value.claimToken),
      claimedAt: exactIso(value.claimed_at_utc, "mailbox_dispatch_invalid"),
      leaseUntil: exactIso(value.lease_until_utc, "mailbox_dispatch_invalid"),
      value,
    });
  }

  parseResult(value) {
    if (!isObject(value) || value.version !== 1) throw coded("mailbox_result_invalid");
    if (value.status === "empty") return Object.freeze({ status: "empty" });
    if (value.status !== "ready") throw coded("mailbox_result_invalid");
    const contractKeys = ["resultContractVersion", "observedAt", "sourceClass", "publicCitations"];
    const contractFields = Object.fromEntries(contractKeys
      .filter((name) => Object.hasOwn(value, name))
      .map((name) => [name, value[name]]));
    return Object.freeze({
      status: "ready",
      requestId: exactRequestId(value.requestId),
      claimToken: exactToken(value.claimToken),
      completion: {
        requestId: value.requestId,
        claimToken: value.claimToken,
        confidence: value.confidence,
        answer: value.answer,
        evidence: value.evidence,
        unresolvedLimits: value.unresolvedLimits,
        ...contractFields,
      },
    });
  }

  idleDispatch(now) {
    return { version: 1, status: "idle", updated_at_utc: now.toISOString() };
  }

  emptyResult() {
    return { version: 1, status: "empty" };
  }

  async writeStatus(status, extra = {}) {
    const current = await this.readStable("status");
    await this.writeAtomic("status", {
      version: 1,
      status,
      updated_at_utc: this.currentTime().toISOString(),
      ...extra,
    }, current.stat);
  }

  async acquireLock() {
    await this.bench.assertDirectory();
    const lock = path.join(this.directory, ".mailbox.lock");
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
        throw coded("mailbox_lock_invalid");
      }
      assertOwner(stat);
      if (await fs.promises.realpath(lock) !== lock) throw coded("mailbox_lock_invalid");
      if (this.currentTime().getTime() - stat.mtimeMs <= LOCK_STALE_MS) throw coded("mailbox_busy");
      const current = await fs.promises.lstat(lock);
      if (current.dev !== stat.dev || current.ino !== stat.ino) throw coded("mailbox_lock_changed");
      await fs.promises.unlink(lock);
      acquired = await create();
    }
    return async () => {
      const current = await fs.promises.lstat(lock);
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || mode(current) !== 0o600 ||
        current.dev !== acquired.dev || current.ino !== acquired.ino) throw coded("mailbox_lock_changed");
      assertOwner(current);
      await fs.promises.unlink(lock);
    };
  }

  async init() {
    const release = await this.acquireLock();
    try {
      await this.hardenResultDrop();
      await this.ensureFiles();
      await this.writeStatus("ready", { network_calls: 0, messages_sent: 0, desktop_actions: 0 });
      return { status: "ready", privateFilesVerified: true };
    } finally {
      await release();
    }
  }

  async once() {
    const release = await this.acquireLock();
    try {
      await this.hardenResultDrop();
      await this.ensureFiles();
      const now = this.currentTime();
      let dispatchRead = await this.readStable("dispatch");
      let resultRead = await this.readStable("result");
      let dispatch = this.parseDispatch(dispatchRead.value);
      let result = this.parseResult(resultRead.value);

      if (result.status === "ready") {
        const completion = await this.bench.complete(result.completion);
        if (dispatch.status === "claimed" && dispatch.requestId === result.requestId && dispatch.claimToken === result.claimToken) {
          await this.writeAtomic("dispatch", this.idleDispatch(now), dispatchRead.stat);
          dispatchRead = await this.readStable("dispatch");
          dispatch = this.parseDispatch(dispatchRead.value);
        }
        await this.writeAtomic("result", this.emptyResult(), resultRead.stat);
        await this.writeStatus("completed", { helper_status: completion.status });
        return { status: "completed", helperStatus: completion.status };
      }

      if (dispatch.status === "claimed") {
        const age = now.getTime() - Date.parse(dispatch.claimedAt);
        if (age > MAX_DISPATCH_AGE_MS) {
          await this.bench.updateClaim({
            requestId: dispatch.requestId,
            claimToken: dispatch.claimToken,
            reasonCode: "temporary_failure",
            retryAfterSeconds: 300,
          }, "defer");
          await this.writeAtomic("dispatch", this.idleDispatch(now), dispatchRead.stat);
          await this.writeStatus("deferred", { reason_code: "dispatch_timeout" });
          return { status: "deferred" };
        }
        if (Date.parse(dispatch.leaseUntil) <= now.getTime() + RENEW_AHEAD_MS) {
          try {
            const renewed = await this.bench.updateClaim({
              requestId: dispatch.requestId,
              claimToken: dispatch.claimToken,
            }, "renew");
            const nextDispatch = { ...dispatch.value, lease_until_utc: renewed.leaseUntil, updated_at_utc: now.toISOString() };
            await this.writeAtomic("dispatch", nextDispatch, dispatchRead.stat);
          } catch (error) {
            if (error?.code !== "claim_not_current") throw error;
            await this.writeAtomic("dispatch", this.idleDispatch(now), dispatchRead.stat);
            await this.writeStatus("requeued", { reason_code: "claim_not_current" });
            return { status: "requeued" };
          }
        }
        await this.writeStatus("awaiting_result");
        return { status: "awaiting_result" };
      }

      const claimed = await this.bench.next();
      if (claimed.status === "idle") {
        await this.writeStatus("idle");
        return { status: "idle" };
      }
      const nextDispatch = {
        version: 1,
        status: "claimed",
        content_trust: claimed.contentTrust,
        instruction: claimed.instruction,
        ...(claimed.requiredResultContract ? {
          required_result_contract: claimed.requiredResultContract,
        } : {}),
        claimToken: claimed.claimToken,
        lease_until_utc: claimed.leaseUntil,
        claimed_at_utc: now.toISOString(),
        updated_at_utc: now.toISOString(),
        requestId: claimed.request.requestId,
        request: claimed.request,
      };
      await this.writeAtomic("dispatch", nextDispatch, dispatchRead.stat);
      await this.writeStatus("dispatched");
      return { status: "dispatched" };
    } catch (error) {
      try { await this.writeStatus("error", { error_code: safeError(error) }); } catch {}
      throw error;
    } finally {
      await release();
    }
  }

  async status() {
    await this.hardenResultDrop();
    await this.ensureFiles();
    const status = await this.readStable("status");
    return status.value;
  }

  async watch() {
    await this.once().catch(() => {});
    let running = false;
    let pending = false;
    let timer = null;
    const run = async () => {
      if (running) {
        pending = true;
        return;
      }
      running = true;
      try {
        do {
          pending = false;
          await this.once().catch(() => {});
        } while (pending);
      } finally {
        running = false;
      }
    };
    const watcher = fs.watch(this.directory, { persistent: true }, (_event, filename) => {
      const name = filename === null ? null : String(filename);
      if (name !== null && name !== FILES.result.name && name !== "INBOX.md") return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, 25);
    });
    const interval = setInterval(() => { void run(); }, 30 * 1000);
    await new Promise((resolve) => {
      const stop = () => resolve();
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    });
    watcher.close();
    clearInterval(interval);
    if (timer !== null) clearTimeout(timer);
    while (running) await new Promise((resolve) => setTimeout(resolve, 10));
    return { status: "stopped" };
  }
}

async function main() {
  const mailbox = new PolarEscalationMailbox();
  const command = process.argv[2] ?? "once";
  let result;
  if (command === "init") result = await mailbox.init();
  else if (command === "once") result = await mailbox.once();
  else if (command === "status") result = await mailbox.status();
  else if (command === "watch") result = await mailbox.watch();
  else throw coded("mailbox_command_invalid");
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
if (isMain) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: safeError(error) })}\n`);
    process.exitCode = 1;
  }
}
