import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { BadRudyConfigStore, defaultConfig } from "../config.mjs";
import { locations } from "../security.mjs";

export function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bad-rudy-test-"));
  fs.chmodSync(home, 0o700);
  return home;
}

export function removeHome(home) {
  fs.rmSync(home, { recursive: true, force: true });
}

export function installConfig(home, overrides = {}) {
  const base = structuredClone(defaultConfig());
  const value = {
    ...base,
    ...overrides,
    scheduler: { ...base.scheduler, ...(overrides.scheduler ?? {}) },
    rateLimits: { ...base.rateLimits, ...(overrides.rateLimits ?? {}) },
    reviewedGateway: { ...base.reviewedGateway, ...(overrides.reviewedGateway ?? {}) },
  };
  const store = new BadRudyConfigStore(locations(home).configPath, { privateAnchor: home });
  store.write(value);
  return store;
}

export function fakeCredentialProvider({ available = true } = {}) {
  return {
    async status() { return { available, code: available ? "ok" : "keychain_missing" }; },
    async withCredential(operation) {
      if (!available) {
        const error = new Error("missing");
        error.code = "keychain_missing";
        throw error;
      }
      const secret = Buffer.from("session-cookie-bundle");
      try { return await operation(secret); } finally { secret.fill(0); }
    },
  };
}

export function fakeWorker({ now, capability = true } = {}) {
  const calls = [];
  return {
    calls,
    async health() {
      return {
        ready: capability,
        playwright: capability ? "ready" : "down",
        ffmpeg: capability ? "ready" : "down",
        capabilities: { "grok:companions:bad-rudy": capability },
      };
    },
    async capture(request) {
      calls.push({ ...request, credential: "[buffer]" });
      const id = crypto.randomUUID();
      const clipPath = path.join(request.outputDirectory, `${id}.mp4`);
      const thumbnailPath = request.exportStill ? path.join(request.outputDirectory, `${id}.jpg`) : null;
      fs.writeFileSync(clipPath, Buffer.from("local fake mp4"), { mode: 0o600 });
      fs.chmodSync(clipPath, 0o600);
      if (thumbnailPath) {
        fs.writeFileSync(thumbnailPath, Buffer.from("local fake jpeg"), { mode: 0o600 });
        fs.chmodSync(thumbnailPath, 0o600);
      }
      return {
        id,
        path: clipPath,
        mime: "video/mp4",
        duration_ms: 5_000,
        thumbnail_path: thumbnailPath,
        prompt: request.prompt,
        created_at: (now?.() ?? new Date()).toISOString(),
        source: "grok:bad-rudy",
      };
    },
  };
}

export function fakePromptFilter({ allow = true } = {}) {
  return { async evaluate() { return { allow, policyVersion: "test-policy/v1", publicReason: allow ? undefined : "Blocked by the shared rule." }; } };
}

export function fakeReviewedDelivery({ ready = true } = {}) {
  const sends = [];
  return {
    sends,
    async health() { return { ready, code: ready ? "ok" : "unavailable" }; },
    async send(request) {
      sends.push(request);
      return { status: "sent", messageId: `fake-${sends.length}`, deduplicated: false, contractVersion: "rico-reviewed-attachment/v1" };
    },
  };
}

export function fakeRateLimitAuthority({ ready = true, approved = true } = {}) {
  const reservations = [];
  const recipientDecisions = [];
  return {
    reservations,
    recipientDecisions,
    approved,
    revision: 1,
    async health() { return { ready, code: ready ? "ok" : "unavailable", policyVersion: ready ? "rico-rate-policy/v1" : null, revision: ready ? this.revision : null }; },
    async reserve(request) {
      reservations.push(request);
      return { approved: this.approved, policyVersion: "rico-rate-policy/v1", revision: this.revision, publicReason: this.approved ? undefined : "Existing rate limit reached." };
    },
    async authorizeRecipient(request) {
      recipientDecisions.push(request);
      return { approved: this.approved, recipient: request.recipient, policyVersion: "rico-recipient-policy/v1", revision: this.revision };
    },
  };
}
