import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { MacOSGrokCredentialProvider } from "../keychain.mjs";
import { BadRudyEventLog } from "../events.mjs";
import { ReviewedRicoAttachmentAdapter } from "../delivery.mjs";
import { validateCapturedClip } from "../captured-clip.mjs";
import { ensurePrivateDirectoryChain, locations } from "../security.mjs";
import { installConfig, makeHome, removeHome } from "./helpers.mjs";

test("Keychain provider uses only the fixed service/account and exposes no env fallback", async () => {
  const calls = [];
  const provider = new MacOSGrokCredentialProvider({
    execFileFn: async (...args) => {
      calls.push(args);
      return { stdout: Buffer.from("secret-session\n"), stderr: Buffer.alloc(0) };
    },
  });
  const length = await provider.withCredential(async (credential) => credential.length);
  assert.equal(length, "secret-session".length);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/usr/bin/security");
  assert.deepEqual(calls[0][1], ["find-generic-password", "-s", "openclaw-grok", "-a", "alan", "-w"]);
  assert.deepEqual(calls[0][2].env, { PATH: "/usr/bin:/bin" });
});

test("missing Keychain fails with a stable public code and never reads environment", async () => {
  const provider = new MacOSGrokCredentialProvider({ execFileFn: async () => { throw new Error("security detail that must not escape"); } });
  await assert.rejects(provider.withCredential(async () => undefined), {
    code: "keychain_missing",
    publicMessage: "Grok credentials are missing from macOS Keychain.",
  });
  assert.deepEqual(await provider.status(), { available: false, service: "openclaw-grok", account: "alan", code: "keychain_missing" });
});

test("JSONL spool rejects credential-shaped fields", (t) => {
  const home = makeHome();
  t.after(() => removeHome(home));
  const log = new BadRudyEventLog(locations(home).eventsPath);
  assert.throws(() => log.write("runtime.blocked", { token: "must-not-log" }), { code: "credential_log_blocked" });
  assert.equal(fs.existsSync(locations(home).eventsPath), false);
});

test("reviewed attachment adapter refuses generic or unverified Gateway seams", async () => {
  const generic = new ReviewedRicoAttachmentAdapter({ gateway: { async call() { return {}; } }, method: "send" });
  assert.equal((await generic.health()).ready, false);

  const calls = [];
  const gateway = {
    async call(method, payload) {
      calls.push({ method, payload });
      if (method === "rico.imessage.attachmentStatus") return { healthy: true, enforcement: { verified: true }, contractVersion: "rico-reviewed-attachment/v1" };
      return { confirmed: true, messageId: "message-1", contractVersion: "rico-reviewed-attachment/v1" };
    },
  };
  const adapter = new ReviewedRicoAttachmentAdapter({ gateway });
  assert.equal((await adapter.health()).ready, true);
  const result = await adapter.send({
    clip: { id: "clip", path: "/local/clip.mp4", mime: "video/mp4", sha256: "a".repeat(64), byte_size: 10 },
    recipient: "+16469433060",
    confirmation: { id: "confirmation", purpose: "initial_send" },
    idempotencyKey: "one-time",
    recipientAuthority: {
      recipient: "+16469433060",
      policyVersion: "rico-recipient-policy/v1",
      revision: "1",
      stage: "initial_confirmation",
    },
  });
  assert.equal(result.status, "sent");
  assert.equal(calls[1].method, "rico.imessage.sendReviewedAttachment");
  assert.equal(calls[1].payload.attachments[0].sha256, "a".repeat(64));
  assert.equal(calls[1].payload.direction, "outbound");
  assert.equal(calls[1].payload.source_ref, "clip");
  assert.equal(calls[1].payload.recipient_authority.revision, "1");
});

test("capture validation rejects a symlinked dated parent even when the final file is regular", async (t) => {
  const home = makeHome();
  t.after(() => removeHome(home));
  const paths = locations(home);
  ensurePrivateDirectoryChain(home, paths.artifactRoot);
  const external = path.join(home, "external-date");
  ensurePrivateDirectoryChain(home, external);
  const id = crypto.randomUUID();
  const actualClip = path.join(external, `${id}.mp4`);
  fs.writeFileSync(actualClip, "local clip", { mode: 0o600 });
  fs.symlinkSync(external, path.join(paths.artifactRoot, "2026-08-15"));
  await assert.rejects(validateCapturedClip({
    id,
    path: path.join(paths.artifactRoot, "2026-08-15", `${id}.mp4`),
    mime: "video/mp4",
    duration_ms: 1_000,
    thumbnail_path: null,
    prompt: "Symlink regression",
    created_at: "2026-08-15T16:00:00.000Z",
    source: "grok:bad-rudy",
  }, {
    artifactRoot: paths.artifactRoot,
    expectedPrompt: "Symlink regression",
    maxDurationSeconds: 20,
  }), { code: "unsafe_state_directory" });
});

test("config creation rejects a symlinked OpenClaw state chain", (t) => {
  const home = makeHome();
  t.after(() => removeHome(home));
  const redirected = path.join(home, "redirected-openclaw");
  ensurePrivateDirectoryChain(home, redirected);
  fs.symlinkSync(redirected, path.join(home, "OpenClaw"));
  assert.throws(() => installConfig(home, { killSwitch: false, dryRun: true, allowedRecipients: ["+16469433060"] }), { code: "unsafe_state_directory" });
});
