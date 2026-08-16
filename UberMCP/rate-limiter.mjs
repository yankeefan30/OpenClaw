import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDirectory, readPrivateJson, writePrivateJson } from "./private-store.mjs";
import { governed } from "./errors.mjs";

const POLICIES = Object.freeze({
  read: Object.freeze({ limit: 30, windowMs: 60_000 }),
  mutation: Object.freeze({ limit: 3, windowMs: 10 * 60_000 }),
  geocode: Object.freeze({ limit: 12, windowMs: 60_000 }),
  monitor: Object.freeze({ limit: 150, windowMs: 10 * 60_000 }),
  oauth: Object.freeze({ limit: 4, windowMs: 10 * 60_000 }),
});

/** Restart-persistent local limiter, deliberately conservative. */
export class PersistentRateLimiter {
  constructor({ directory, now = () => new Date() } = {}) {
    this.directory = ensurePrivateDirectory(directory);
    this.filePath = path.join(this.directory, "rate-limits.json");
    this.lockPath = path.join(this.directory, "rate-limits.lock");
    this.now = now;
  }

  acquire(kind) {
    const policy = POLICIES[kind];
    if (!policy) throw governed("rate_limit_kind_invalid", "The Uber local rate-limit kind is invalid.");
    return this.withLock(() => {
      const now = this.timestamp();
      const state = this.read();
      for (const [name, values] of Object.entries(state.events)) {
        const windowMs = POLICIES[name]?.windowMs ?? 60_000;
        state.events[name] = values.filter((at) => Number.isFinite(at) && at > now - windowMs);
      }
      if (state.events[kind].length >= policy.limit) {
        throw governed(kind === "mutation" ? "local_mutation_rate_limit" : "local_rate_limit", "Rico's persistent local Uber rate limit was reached. No additional action was sent.", { retryable: kind !== "mutation" });
      }
      state.events[kind].push(now);
      state.updatedAt = new Date(now).toISOString();
      writePrivateJson(this.filePath, state);
      return Object.freeze({ remaining: policy.limit - state.events[kind].length, resetsAfterMs: policy.windowMs });
    });
  }

  read() {
    if (!fs.existsSync(this.filePath)) return { schema: "openclaw.uber.rate-limits", version: 1, updatedAt: null, events: { read: [], mutation: [], geocode: [], monitor: [], oauth: [] } };
    const value = readPrivateJson(this.filePath);
    if (value?.schema !== "openclaw.uber.rate-limits" || value.version !== 1 || !value.events || Object.keys(value.events).sort().join() !== Object.keys(POLICIES).sort().join()) {
      throw governed("rate_limit_state_invalid", "The persistent Uber rate-limit state is invalid.");
    }
    for (const values of Object.values(value.events)) if (!Array.isArray(values) || values.some((item) => !Number.isFinite(item))) throw governed("rate_limit_state_invalid", "The persistent Uber rate-limit state is invalid.");
    return value;
  }

  withLock(operation) {
    let descriptor;
    try {
      descriptor = fs.openSync(this.lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    } catch (error) {
      if (error?.code === "EEXIST") throw governed("rate_limiter_busy", "The persistent Uber rate limiter is busy; retry later.", { retryable: true });
      throw error;
    }
    try {
      fs.writeFileSync(descriptor, `${process.pid}\n`);
      fs.fsyncSync(descriptor);
      return operation();
    } finally {
      fs.closeSync(descriptor);
      const stat = fs.lstatSync(this.lockPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw governed("rate_limit_lock_invalid", "The Uber rate-limit lock is unsafe.");
      fs.unlinkSync(this.lockPath);
    }
  }

  timestamp() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw governed("clock_invalid", "The Uber rate-limit clock is invalid.");
    return date.getTime();
  }
}
