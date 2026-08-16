import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWritePrivateJson, readPrivateJson, ensurePrivateDirectory } from "./security.mjs";
import { codedError } from "./errors.mjs";

export class LockedJsonStore {
  constructor(filePath, emptyValue) {
    this.filePath = filePath;
    this.emptyValue = emptyValue;
  }

  read() {
    return readPrivateJson(this.filePath, this.emptyValue);
  }

  update(operation) {
    const directory = ensurePrivateDirectory(path.dirname(this.filePath));
    const lockPath = `${this.filePath}.lock`;
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
    } catch (error) {
      throw codedError("state_busy", "Bad Rudy's local state is busy; nothing was sent or changed.", error);
    }
    try {
      const current = this.read();
      const result = operation(current);
      atomicWritePrivateJson(this.filePath, current);
      return result;
    } finally {
      try {
        const stat = fs.lstatSync(lockPath);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe lock path");
        fs.rmdirSync(lockPath);
      } catch {
        // A stuck lock is fail-closed and requires operator inspection. Do not
        // escalate to recursive deletion or weaken path checks here.
      }
      void directory;
    }
  }
}

export class CaptureStore {
  constructor(filePath) {
    this.store = new LockedJsonStore(filePath, { schema: "openclaw.bad-rudy-captures/v1", captures: [] });
  }

  put(clip, delivery) {
    return this.store.update((state) => {
      assertEnvelope(state, "openclaw.bad-rudy-captures/v1", "captures");
      if (state.captures.some((row) => row.clip.id === clip.id)) throw codedError("capture_duplicate", "This capture is already recorded.");
      state.captures.unshift({ clip, delivery, recordedAt: new Date().toISOString() });
      state.captures = state.captures.slice(0, 100);
      return clip;
    });
  }

  get(id) {
    const state = this.store.read();
    assertEnvelope(state, "openclaw.bad-rudy-captures/v1", "captures");
    return state.captures.find((row) => row.clip.id === id) ?? null;
  }

  recent(limit = 20) {
    const state = this.store.read();
    assertEnvelope(state, "openclaw.bad-rudy-captures/v1", "captures");
    return state.captures.slice(0, Math.max(0, Math.min(20, Number(limit) || 20)));
  }
}

export class ConfirmationStore {
  constructor(filePath, { now = () => new Date() } = {}) {
    this.store = new LockedJsonStore(filePath, { schema: "openclaw.bad-rudy-confirmations/v1", confirmations: [] });
    this.now = now;
  }

  issue({ purpose, clipId, delivery, display, scheduleId = null, ttlSeconds = 900 }) {
    const now = this.now();
    const challenge = Object.freeze({
      id: crypto.randomUUID(),
      purpose,
      clipId,
      delivery,
      display,
      scheduleId,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlSeconds * 1_000).toISOString(),
    });
    this.store.update((state) => {
      assertEnvelope(state, "openclaw.bad-rudy-confirmations/v1", "confirmations");
      state.confirmations = state.confirmations.filter((item) => item.state === "pending" && Date.parse(item.expiresAt) > now.getTime()).slice(-99);
      state.confirmations.push({ ...challenge, state: "pending" });
    });
    return challenge;
  }

  consume(id, purpose) {
    return this.store.update((state) => {
      assertEnvelope(state, "openclaw.bad-rudy-confirmations/v1", "confirmations");
      const row = state.confirmations.find((item) => item.id === id);
      if (!row || row.state !== "pending" || row.purpose !== purpose) throw codedError("confirmation_required", "Explicit human confirmation is required.");
      if (Date.parse(row.expiresAt) <= this.now().getTime()) {
        row.state = "expired";
        throw codedError("confirmation_expired", "The confirmation expired; review the clip again.");
      }
      row.state = "consumed";
      row.consumedAt = this.now().toISOString();
      return structuredClone(row);
    });
  }

  get(id, purpose) {
    const state = this.store.read();
    assertEnvelope(state, "openclaw.bad-rudy-confirmations/v1", "confirmations");
    const row = state.confirmations.find((item) => item.id === id);
    if (!row || row.state !== "pending" || row.purpose !== purpose) throw codedError("confirmation_required", "Explicit human confirmation is required.");
    if (Date.parse(row.expiresAt) <= this.now().getTime()) throw codedError("confirmation_expired", "The confirmation expired; review the clip again.");
    return structuredClone(row);
  }
}

export class DedupeStore {
  constructor(filePath, { now = () => new Date() } = {}) {
    this.store = new LockedJsonStore(filePath, { schema: "openclaw.bad-rudy-dedupe/v1", claims: [] });
    this.now = now;
  }

  claim(prompt, recipient) {
    const now = this.now();
    const minuteBucket = Math.floor(now.getTime() / 60_000);
    const normalizedPrompt = String(prompt).trim().replace(/\s+/gu, " ").toLowerCase();
    const key = crypto.createHash("sha256").update(`${normalizedPrompt}\u0000${recipient}\u0000${minuteBucket}`, "utf8").digest("hex");
    this.store.update((state) => {
      assertEnvelope(state, "openclaw.bad-rudy-dedupe/v1", "claims");
      state.claims = state.claims.filter((item) => item.expiresAt > now.getTime());
      if (state.claims.some((item) => item.key === key)) throw codedError("capture_duplicate", "The same Bad Rudy prompt and recipient was already submitted this minute.");
      state.claims.push({ key, expiresAt: now.getTime() + 2 * 60_000 });
    });
    return key;
  }
}

export class PersistentRateLimiter {
  constructor(filePath, { now = () => new Date() } = {}) {
    this.store = new LockedJsonStore(filePath, { schema: "openclaw.bad-rudy-rate/v1", events: [] });
    this.now = now;
  }

  reserve(kind, recipient, config) {
    const now = this.now();
    const cutoff = now.getTime() - 60 * 60_000;
    this.store.update((state) => {
      assertEnvelope(state, "openclaw.bad-rudy-rate/v1", "events");
      state.events = state.events.filter((event) => event.at > cutoff);
      if (kind === "capture") {
        const globalCount = state.events.filter((event) => event.kind === "capture").length;
        if (globalCount >= config.globalCapturesPerHour) throw codedError("global_rate_limit", "Bad Rudy's global capture rate limit has been reached.");
      } else if (kind === "send") {
        const recipientCount = state.events.filter((event) => event.kind === "send" && event.recipient === recipient).length;
        if (recipientCount >= config.perRecipientSendsPerHour) throw codedError("recipient_rate_limit", "Bad Rudy's recipient send rate limit has been reached.");
      } else {
        throw codedError("rate_scope_invalid", "Bad Rudy's rate limiter rejected an unknown operation.");
      }
      state.events.push({ kind, recipient, at: now.getTime() });
    });
  }
}

function assertEnvelope(value, schema, arrayKey) {
  if (!value || value.schema !== schema || !Array.isArray(value[arrayKey])) throw codedError("state_schema_invalid", "Bad Rudy's local state schema is invalid.");
}
