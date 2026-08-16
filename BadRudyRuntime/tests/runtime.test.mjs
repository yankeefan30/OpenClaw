import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { BadRudyRuntime } from "../runtime.mjs";
import { defaultConfig } from "../config.mjs";
import { locations } from "../security.mjs";
import { fakeCredentialProvider, fakePromptFilter, fakeRateLimitAuthority, fakeReviewedDelivery, fakeWorker, installConfig, makeHome, removeHome } from "./helpers.mjs";

const RECIPIENT = "+16469433060";

test("a new environment starts kill-switched and dry-run", () => {
  const config = defaultConfig();
  assert.equal(config.killSwitch, true);
  assert.equal(config.dryRun, true);
  assert.deepEqual(config.allowedRecipients, []);
});

test("workflow capture is channel-neutral and writes a local completion event", async (t) => {
  const home = makeHome();
  t.after(() => removeHome(home));
  const now = () => new Date("2026-08-15T16:00:00.000Z");
  installConfig(home, { killSwitch: false, dryRun: true, allowedRecipients: [RECIPIENT] });
  const worker = fakeWorker({ now });
  const delivery = fakeReviewedDelivery();
  const runtime = new BadRudyRuntime({ homeDirectory: home, worker, credentialProvider: fakeCredentialProvider(), promptFilter: fakePromptFilter(), reviewedDelivery: delivery, rateLimitAuthority: fakeRateLimitAuthority(), now });

  const result = await runtime.capture({ source: "human:studio", prompt: "Say hello from the local test", delivery: "workflow" });
  assert.equal(result.status, "captured");
  assert.equal(result.clip.source, "grok:bad-rudy");
  assert.match(result.clip.path, /OpenClaw\/artifacts\/bad-rudy\/2026-08-15\/[0-9a-f-]+\.mp4$/u);
  assert.equal(worker.calls.length, 1);
  assert.equal("recipient" in worker.calls[0], false, "capture worker must not know delivery recipient");
  assert.equal(delivery.sends.length, 0);
  assert.equal(runtime.recentEvents()[0].type, "capture.completed");
  assert.equal(runtime.recentCaptures()[0].deliveryStatus, "log_only");
});

test("dry-run captures but records would_send without delivery or confirmation", async (t) => {
  const home = makeHome();
  t.after(() => removeHome(home));
  const now = () => new Date("2026-08-15T16:00:00.000Z");
  installConfig(home, { killSwitch: false, dryRun: true, allowedRecipients: [RECIPIENT] });
  const delivery = fakeReviewedDelivery();
  const runtime = new BadRudyRuntime({ homeDirectory: home, worker: fakeWorker({ now }), credentialProvider: fakeCredentialProvider(), promptFilter: fakePromptFilter(), reviewedDelivery: delivery, rateLimitAuthority: fakeRateLimitAuthority(), now });

  const result = await runtime.capture({ source: "human:studio", prompt: "Deliver only in dry-run", delivery: "rico", recipient: RECIPIENT });
  assert.equal(result.delivery.status, "would_send");
  assert.equal(result.confirmation, null);
  assert.equal(delivery.sends.length, 0);
  assert.equal(runtime.recentEvents()[0].type, "delivery.would_send");
  assert.equal(runtime.recentCaptures()[0].deliveryStatus, "would_send");
});

test("Rico and scheduler capture are disabled when the reviewed attachment seam is absent", async (t) => {
  const home = makeHome();
  t.after(() => removeHome(home));
  const now = () => new Date("2026-08-15T16:00:00.000Z");
  installConfig(home, { killSwitch: false, dryRun: true, allowedRecipients: [RECIPIENT] });
  const worker = fakeWorker({ now });
  const runtime = new BadRudyRuntime({ homeDirectory: home, worker, credentialProvider: fakeCredentialProvider(), promptFilter: fakePromptFilter(), reviewedDelivery: null, rateLimitAuthority: fakeRateLimitAuthority(), now });
  await assert.rejects(runtime.capture({ source: "human:studio", prompt: "No raw Gateway fallback", delivery: "rico", recipient: RECIPIENT }), { code: "reviewed_delivery_unavailable" });
  assert.equal(worker.calls.length, 0);
});

test("real Rico delivery requires and consumes an explicit human confirmation", async (t) => {
  const home = makeHome();
  t.after(() => removeHome(home));
  const now = () => new Date("2026-08-15T16:00:00.000Z");
  installConfig(home, { killSwitch: false, dryRun: false, allowedRecipients: [RECIPIENT] });
  const delivery = fakeReviewedDelivery();
  const runtime = new BadRudyRuntime({ homeDirectory: home, worker: fakeWorker({ now }), credentialProvider: fakeCredentialProvider(), promptFilter: fakePromptFilter(), reviewedDelivery: delivery, rateLimitAuthority: fakeRateLimitAuthority(), now });
  const captured = await runtime.capture({ source: "human:studio", prompt: "A reviewed outbound clip", delivery: "rico", recipient: RECIPIENT });
  assert.equal(captured.status, "awaiting_confirmation");
  assert.equal(captured.confirmation.display.recipient, RECIPIENT);
  assert.equal(captured.confirmation.display.byteSize, captured.clip.byte_size);
  assert.equal(captured.confirmation.display.thumbnailPath, captured.clip.thumbnail_path);
  assert.ok(captured.clip.thumbnail_path, "a real-send review must always have a local still");
  assert.equal(delivery.sends.length, 0);

  await assert.rejects(runtime.confirmInitial({ confirmationId: captured.confirmation.id, confirmedBy: "automation" }), { code: "confirmation_required" });
  assert.equal(delivery.sends.length, 0);
  const outcome = await runtime.confirmInitial({ confirmationId: captured.confirmation.id, confirmedBy: "human:studio" });
  assert.equal(outcome.status, "sent");
  assert.equal(delivery.sends.length, 1);
  assert.equal(runtime.recentCaptures()[0].deliveryStatus, "sent");
  await assert.rejects(runtime.confirmInitial({ confirmationId: captured.confirmation.id, confirmedBy: "human:studio" }), { code: "confirmation_required" });
  assert.equal(delivery.sends.length, 1);
});

test("real outbound capture forces a still even when the optional UI toggle is off", async (t) => {
  const home = makeHome();
  t.after(() => removeHome(home));
  const now = () => new Date("2026-08-15T16:00:00.000Z");
  installConfig(home, { killSwitch: false, dryRun: false, allowedRecipients: [RECIPIENT] });
  const worker = fakeWorker({ now });
  const runtime = new BadRudyRuntime({ homeDirectory: home, worker, credentialProvider: fakeCredentialProvider(), promptFilter: fakePromptFilter(), reviewedDelivery: fakeReviewedDelivery(), rateLimitAuthority: fakeRateLimitAuthority(), now });

  const captured = await runtime.capture({
    source: "human:studio",
    prompt: "Force the review thumbnail",
    delivery: "rico",
    recipient: RECIPIENT,
    advanced: { exportStill: false },
  });

  assert.equal(worker.calls[0].exportStill, true);
  assert.ok(captured.clip.thumbnail_path);
  assert.equal(captured.confirmation.display.thumbnailPath, captured.clip.thumbnail_path);
});

test("live Rico revocation between capture and confirmation blocks without consuming review", async (t) => {
  const home = makeHome();
  t.after(() => removeHome(home));
  const now = () => new Date("2026-08-15T16:00:00.000Z");
  installConfig(home, { killSwitch: false, dryRun: false, allowedRecipients: [RECIPIENT] });
  const authority = fakeRateLimitAuthority();
  const delivery = fakeReviewedDelivery();
  const runtime = new BadRudyRuntime({ homeDirectory: home, worker: fakeWorker({ now }), credentialProvider: fakeCredentialProvider(), promptFilter: fakePromptFilter(), reviewedDelivery: delivery, rateLimitAuthority: authority, now });
  const captured = await runtime.capture({ source: "human:studio", prompt: "Recheck recipient live", delivery: "rico", recipient: RECIPIENT });
  assert.equal(authority.recipientDecisions[0].stage, "capture");

  authority.approved = false;
  authority.revision = 2;
  await assert.rejects(runtime.confirmInitial({ confirmationId: captured.confirmation.id, confirmedBy: "human:studio" }), { code: "recipient_revoked" });
  assert.equal(delivery.sends.length, 0);
  assert.ok(runtime.confirmations.get(captured.confirmation.id, "initial_send"), "revocation must leave explicit review unconsumed");

  authority.approved = true;
  const outcome = await runtime.confirmInitial({ confirmationId: captured.confirmation.id, confirmedBy: "human:studio" });
  assert.equal(outcome.status, "sent");
  assert.equal(delivery.sends[0].recipientAuthority.revision, "2");
  assert.equal(delivery.sends[0].recipientAuthority.stage, "initial_confirmation");
});

test("scheduler needs one confirmation to queue and a second after becoming due", async (t) => {
  const home = makeHome();
  t.after(() => removeHome(home));
  let current = new Date("2026-08-15T16:00:00.000Z");
  const now = () => new Date(current);
  installConfig(home, { killSwitch: false, dryRun: false, allowedRecipients: [RECIPIENT] });
  const delivery = fakeReviewedDelivery();
  const runtime = new BadRudyRuntime({ homeDirectory: home, worker: fakeWorker({ now }), credentialProvider: fakeCredentialProvider(), promptFilter: fakePromptFilter(), reviewedDelivery: delivery, rateLimitAuthority: fakeRateLimitAuthority(), now });
  const captured = await runtime.capture({
    source: "human:studio",
    prompt: "A twice-confirmed scheduled clip",
    delivery: "scheduler",
    recipient: RECIPIENT,
    scheduledAt: "2026-08-15T12:10:00-04:00",
  });
  const queued = await runtime.confirmInitial({ confirmationId: captured.confirmation.id, confirmedBy: "human:studio" });
  assert.equal(queued.status, "scheduled");
  assert.equal(delivery.sends.length, 0);
  assert.deepEqual(runtime.tickScheduler(), []);

  current = new Date("2026-08-15T16:10:01.000Z");
  const due = runtime.tickScheduler();
  assert.equal(due.length, 1);
  assert.equal(due[0].purpose, "scheduled_fire");
  assert.equal(delivery.sends.length, 0, "a scheduler tick must never send");
  const restored = runtime.tickScheduler();
  assert.equal(restored[0].id, due[0].id, "a later UI refresh must recover the persisted due confirmation");
  const outcome = await runtime.confirmScheduledFire({ confirmationId: due[0].id, confirmedBy: "human:studio" });
  assert.equal(outcome.status, "sent");
  assert.equal(delivery.sends.length, 1);
});

test("scheduled fire rechecks live Rico recipient authority after queuing", async (t) => {
  const home = makeHome();
  t.after(() => removeHome(home));
  let current = new Date("2026-08-15T16:00:00.000Z");
  const now = () => new Date(current);
  installConfig(home, { killSwitch: false, dryRun: false, allowedRecipients: [RECIPIENT] });
  const authority = fakeRateLimitAuthority();
  const delivery = fakeReviewedDelivery();
  const runtime = new BadRudyRuntime({ homeDirectory: home, worker: fakeWorker({ now }), credentialProvider: fakeCredentialProvider(), promptFilter: fakePromptFilter(), reviewedDelivery: delivery, rateLimitAuthority: authority, now });
  const captured = await runtime.capture({
    source: "human:studio",
    prompt: "Revocable schedule",
    delivery: "scheduler",
    recipient: RECIPIENT,
    scheduledAt: "2026-08-15T12:10:00-04:00",
  });
  await runtime.confirmInitial({ confirmationId: captured.confirmation.id, confirmedBy: "human:studio" });
  current = new Date("2026-08-15T16:10:01.000Z");
  const fire = runtime.tickScheduler()[0];
  authority.approved = false;
  authority.revision = 3;
  await assert.rejects(runtime.confirmScheduledFire({ confirmationId: fire.id, confirmedBy: "human:studio" }), { code: "recipient_revoked" });
  assert.equal(delivery.sends.length, 0);
  assert.ok(runtime.confirmations.get(fire.id, "scheduled_fire"));
  authority.approved = true;
  const outcome = await runtime.confirmScheduledFire({ confirmationId: fire.id, confirmedBy: "human:studio" });
  assert.equal(outcome.status, "sent");
  assert.equal(delivery.sends[0].recipientAuthority.revision, "3");
  assert.equal(delivery.sends[0].recipientAuthority.stage, "scheduled_fire_confirmation");
});

test("all fail-closed gates prevent capture", async (t) => {
  const scenarios = [
    ["keychain", { credentials: false }, "keychain_missing"],
    ["kill", { killSwitch: true }, "kill_switch_on"],
    ["allowlist", { allowlist: [] }, "allowlist_empty"],
    ["worker", { capability: false }, "playwright_worker_down"],
    ["existing rate authority", { rateReady: false }, "rate_limit_authority_unavailable"],
  ];
  for (const [name, scenario, code] of scenarios) {
    await t.test(name, async (t2) => {
      const home = makeHome();
      t2.after(() => removeHome(home));
      const now = () => new Date("2026-08-15T16:00:00.000Z");
      installConfig(home, {
        killSwitch: scenario.killSwitch ?? false,
        dryRun: true,
        allowedRecipients: scenario.allowlist ?? [RECIPIENT],
      });
      const worker = fakeWorker({ now, capability: scenario.capability ?? true });
      const runtime = new BadRudyRuntime({ homeDirectory: home, worker, credentialProvider: fakeCredentialProvider({ available: scenario.credentials ?? true }), promptFilter: fakePromptFilter(), reviewedDelivery: fakeReviewedDelivery(), rateLimitAuthority: fakeRateLimitAuthority({ ready: scenario.rateReady ?? true }), now });
      await assert.rejects(runtime.capture({ source: "human:studio", prompt: "Should not run", delivery: "workflow" }), { code });
      assert.equal(worker.calls.length, 0);
    });
  }
});

test("the existing Rico rate-limit authority can deny before Playwright capture", async (t) => {
  const home = makeHome();
  t.after(() => removeHome(home));
  const now = () => new Date("2026-08-15T16:00:00.000Z");
  installConfig(home, { killSwitch: false, dryRun: true, allowedRecipients: [RECIPIENT] });
  const worker = fakeWorker({ now });
  const runtime = new BadRudyRuntime({
    homeDirectory: home,
    worker,
    credentialProvider: fakeCredentialProvider(),
    promptFilter: fakePromptFilter(),
    reviewedDelivery: fakeReviewedDelivery(),
    rateLimitAuthority: fakeRateLimitAuthority({ approved: false }),
    now,
  });
  await assert.rejects(runtime.capture({ source: "human:studio", prompt: "Rate denied", delivery: "workflow" }), { code: "rate_limit_denied" });
  assert.equal(worker.calls.length, 0);
});

test("officially unavailable Bad Rudy web capability cannot be substituted", async (t) => {
  const home = makeHome();
  t.after(() => removeHome(home));
  installConfig(home, { killSwitch: false, dryRun: true, allowedRecipients: [RECIPIENT] });
  const worker = fakeWorker({ capability: false });
  // A worker that says it is otherwise ready but omits the exact capability
  // must still fail closed.
  worker.health = async () => ({ ready: true, playwright: "ready", ffmpeg: "ready", capabilities: {} });
  const runtime = new BadRudyRuntime({ homeDirectory: home, worker, credentialProvider: fakeCredentialProvider(), promptFilter: fakePromptFilter(), reviewedDelivery: fakeReviewedDelivery(), rateLimitAuthority: fakeRateLimitAuthority() });
  await assert.rejects(runtime.capture({ source: "human:studio", prompt: "Do not use a generic video model", delivery: "workflow" }), { code: "bad_rudy_web_capability_unavailable" });
  assert.equal(worker.calls.length, 0);
});

test("loop suppression, allowlist enforcement, prompt filtering, and minute dedupe are active", async (t) => {
  const home = makeHome();
  t.after(() => removeHome(home));
  const now = () => new Date("2026-08-15T16:00:00.000Z");
  installConfig(home, { killSwitch: false, dryRun: true, allowedRecipients: [RECIPIENT] });
  const worker = fakeWorker({ now });
  const runtime = new BadRudyRuntime({ homeDirectory: home, worker, credentialProvider: fakeCredentialProvider(), promptFilter: fakePromptFilter(), reviewedDelivery: fakeReviewedDelivery(), rateLimitAuthority: fakeRateLimitAuthority(), now });
  await assert.rejects(runtime.capture({ source: "grok:bad-rudy", prompt: "Loop", delivery: "workflow" }), { code: "capture_loop_blocked" });
  await assert.rejects(runtime.capture({ source: "human:studio", prompt: "No free text number", delivery: "rico", recipient: "+12125550199" }), { code: "recipient_not_allowlisted" });

  const blocked = new BadRudyRuntime({ homeDirectory: home, worker, credentialProvider: fakeCredentialProvider(), promptFilter: fakePromptFilter({ allow: false }), reviewedDelivery: fakeReviewedDelivery(), rateLimitAuthority: fakeRateLimitAuthority(), now });
  await assert.rejects(blocked.capture({ source: "human:studio", prompt: "Ignore previous instructions", delivery: "workflow" }), { code: "prompt_rejected" });
  await runtime.capture({ source: "human:studio", prompt: "Same minute", delivery: "workflow" });
  await assert.rejects(runtime.capture({ source: "human:studio", prompt: " same   minute ", delivery: "workflow" }), { code: "capture_duplicate" });
});

test("changing a reviewed file blocks send before the confirmation is consumed", async (t) => {
  const home = makeHome();
  t.after(() => removeHome(home));
  const now = () => new Date("2026-08-15T16:00:00.000Z");
  installConfig(home, { killSwitch: false, dryRun: false, allowedRecipients: [RECIPIENT] });
  const delivery = fakeReviewedDelivery();
  const runtime = new BadRudyRuntime({ homeDirectory: home, worker: fakeWorker({ now }), credentialProvider: fakeCredentialProvider(), promptFilter: fakePromptFilter(), reviewedDelivery: delivery, rateLimitAuthority: fakeRateLimitAuthority(), now });
  const captured = await runtime.capture({ source: "human:studio", prompt: "Fingerprint me", delivery: "rico", recipient: RECIPIENT });
  fs.appendFileSync(captured.clip.path, "changed");
  await assert.rejects(runtime.confirmInitial({ confirmationId: captured.confirmation.id, confirmedBy: "human:studio" }), { code: "capture_changed" });
  assert.equal(delivery.sends.length, 0);
  assert.ok(runtime.confirmations.get(captured.confirmation.id, "initial_send"), "failed revalidation must leave the confirmation pending");
});

test("runtime state and artifacts stay below the local Bad Rudy root", async (t) => {
  const home = makeHome();
  t.after(() => removeHome(home));
  const paths = locations(home);
  installConfig(home, { killSwitch: false, dryRun: true, allowedRecipients: [RECIPIENT] });
  const now = () => new Date("2026-08-15T16:00:00.000Z");
  const runtime = new BadRudyRuntime({ homeDirectory: home, worker: fakeWorker({ now }), credentialProvider: fakeCredentialProvider(), promptFilter: fakePromptFilter(), reviewedDelivery: fakeReviewedDelivery(), rateLimitAuthority: fakeRateLimitAuthority(), now });
  await runtime.capture({ source: "human:studio", prompt: "Local only", delivery: "workflow" });
  for (const file of [paths.configPath, paths.eventsPath, paths.capturesPath, paths.dedupePath, paths.ratePath]) {
    assert.ok(file.startsWith(`${paths.artifactRoot}/`));
    assert.equal(fs.existsSync(file), true);
  }
});
