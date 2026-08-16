import { createHash } from "node:crypto";
import { BadRudyConfigStore, normalizeRecipient } from "./config.mjs";
import { validateCapturedClip, confirmationDisplay, assertClipFingerprint } from "./captured-clip.mjs";
import { deliveryIdempotencyKey } from "./delivery.mjs";
import { BadRudyEventLog } from "./events.mjs";
import { runtimeStatus, assertCaptureReady, assertSendReady } from "./gates.mjs";
import { assertHumanCaptureSource, validatePrompt } from "./prompt.mjs";
import { BadRudyScheduler } from "./scheduler.mjs";
import { CaptureStore, ConfirmationStore, DedupeStore, PersistentRateLimiter } from "./stores.mjs";
import fs from "node:fs";
import { assertPrivateDirectoryChain, dateArtifactDirectory, ensurePrivateDirectoryChain, locations } from "./security.mjs";
import { codedError, safeError } from "./errors.mjs";

const DELIVERY_KINDS = new Set(["workflow", "rico", "scheduler"]);

export class BadRudyRuntime {
  constructor({
    homeDirectory,
    worker,
    credentialProvider,
    promptFilter,
    reviewedDelivery,
    rateLimitAuthority,
    now = () => new Date(),
  }) {
    this.paths = locations(homeDirectory);
    this.worker = worker;
    this.credentialProvider = credentialProvider;
    this.promptFilter = promptFilter;
    this.reviewedDelivery = reviewedDelivery;
    this.rateLimitAuthority = rateLimitAuthority;
    this.now = now;
    this.configStore = new BadRudyConfigStore(this.paths.configPath, { privateAnchor: this.paths.home });
    this.events = new BadRudyEventLog(this.paths.eventsPath, { now });
    this.captures = new CaptureStore(this.paths.capturesPath);
    this.confirmations = new ConfirmationStore(this.paths.confirmationPath, { now });
    this.scheduler = new BadRudyScheduler(this.paths.queuePath, { now });
    this.dedupe = new DedupeStore(this.paths.dedupePath, { now });
    this.rateLimiter = new PersistentRateLimiter(this.paths.ratePath, { now });
  }

  async status() {
    let config;
    try {
      this.#assertStorageIfPresent();
      config = this.configStore.read();
    } catch (error) {
      return Object.freeze({
        keychain: { ready: false, code: "config_invalid" },
        worker: { ready: false, capability: false, code: "config_invalid" },
        dryRun: true,
        killSwitch: true,
        allowlistCount: 0,
        reviewedDelivery: { ready: false, code: "config_invalid" },
        rateLimits: { ready: false, code: "config_invalid", policyVersion: null },
        captureReady: false,
        sendReady: false,
        reasons: [safeError(error).code],
      });
    }
    return runtimeStatus({ config, credentialProvider: this.credentialProvider, worker: this.worker, reviewedDelivery: this.reviewedDelivery, rateLimitAuthority: this.rateLimitAuthority });
  }

  async capture(request) {
    assertHumanCaptureSource(request?.source);
    this.#ensureStorage();
    const config = this.configStore.read();
    const delivery = this.#validateDelivery(request, config);
    const status = await runtimeStatus({ config, credentialProvider: this.credentialProvider, worker: this.worker, reviewedDelivery: this.reviewedDelivery, rateLimitAuthority: this.rateLimitAuthority });
    assertCaptureReady(status);
    if (delivery.kind !== "workflow" && status.reviewedDelivery.ready !== true) {
      throw codedError("reviewed_delivery_unavailable", "Rico's reviewed attachment delivery boundary is unavailable.");
    }
    const promptResult = await validatePrompt(request?.prompt, this.promptFilter);
    const requestedAdvanced = this.#validateAdvanced(request?.advanced, config);
    // Any capture that could become a real outbound send must include the
    // still shown at the human review boundary. Workflow-only and immutable
    // dry-run captures may honor the optional still-frame preference.
    const requiresThumbnail = delivery.kind !== "workflow" && !config.dryRun;
    const advanced = Object.freeze({
      ...requestedAdvanced,
      exportStill: requiresThumbnail ? true : requestedAdvanced.exportStill,
    });
    const caption = await this.#validateCaption(request?.caption);
    const recipientAuthority = delivery.recipient
      ? await this.#authorizeRecipient(delivery.recipient, "capture")
      : null;
    const recipientKey = delivery.recipient ?? "workflow";
    this.dedupe.claim(promptResult.prompt, recipientKey);
    await this.#reserveExistingRate("capture", delivery.recipient, config);
    this.rateLimiter.reserve("capture", recipientKey, config.rateLimits);
    const outputDirectory = dateArtifactDirectory(this.paths.artifactRoot, this.now());
    ensurePrivateDirectoryChain(this.paths.home, outputDirectory);

    let rawClip;
    try {
      rawClip = await this.credentialProvider.withCredential(async (credential) => this.worker.capture({
        prompt: promptResult.prompt,
        format: advanced.format,
        maxDurationSeconds: advanced.maxDurationSeconds,
        exportStill: advanced.exportStill,
        retries: advanced.retries,
        outputDirectory,
        credential,
        requiredCapability: "grok:companions:bad-rudy",
        governance: {
          killSwitch: config.killSwitch,
          dryRun: config.dryRun,
          allowlistReady: config.allowedRecipients.length > 0,
          rateLimitApproved: true,
          promptApproval: {
            approved: true,
            policyVersion: promptResult.policyVersion,
            sha256: cryptoDigest(promptResult.prompt),
          },
          runtimeCapabilityProbe: status.worker.capability === true,
        },
      }));
    } catch (error) {
      this.events.write("runtime.blocked", { stage: "capture", errorCode: safeError(error).code });
      throw error;
    }
    const clip = await validateCapturedClip(rawClip, {
      artifactRoot: this.paths.artifactRoot,
      expectedPrompt: promptResult.prompt,
      maxDurationSeconds: advanced.maxDurationSeconds,
      requireThumbnail: requiresThumbnail,
    });
    const deliveryRecord = Object.freeze({
      kind: delivery.kind,
      recipient: delivery.recipient,
      scheduledAt: delivery.scheduledAt,
      caption,
      dryRunAtCapture: config.dryRun,
      recipientAuthorityAtCapture: recipientAuthority,
    });
    this.captures.put(clip, deliveryRecord);
    this.events.write("capture.completed", { clip, delivery: deliveryRecord });

    if (delivery.kind === "workflow") {
      return Object.freeze({ status: "captured", clip, delivery: { status: "log_only" }, confirmation: null });
    }
    if (config.dryRun) {
      const event = this.events.write("delivery.would_send", {
        clipId: clip.id,
        recipient: delivery.recipient,
        requestedDelivery: delivery.kind,
        scheduledAt: delivery.scheduledAt,
        reason: "dry_run_at_capture",
      });
      return Object.freeze({ status: "captured", clip, delivery: { status: "would_send", eventId: event.id }, confirmation: null });
    }

    const purpose = delivery.kind === "scheduler" ? "initial_schedule" : "initial_send";
    const confirmation = this.confirmations.issue({
      purpose,
      clipId: clip.id,
      delivery: delivery.kind,
      display: confirmationDisplay(clip, {
        recipient: delivery.recipient,
        channel: "imessage",
        scheduledAt: delivery.scheduledAt,
      }),
    });
    return Object.freeze({ status: "awaiting_confirmation", clip, delivery: deliveryRecord, confirmation });
  }

  async confirmInitial({ confirmationId, confirmedBy }) {
    this.#assertStorage();
    assertHumanConfirmation(confirmedBy);
    const pending = this.#pendingInitial(confirmationId);
    const row = this.#captureRecord(pending.clipId);
    await assertClipFingerprint(row.clip, this.paths.artifactRoot, {
      requireThumbnail: row.delivery.kind !== "workflow" && row.delivery.dryRunAtCapture !== true,
    });
    const config = this.configStore.read();
    this.#assertRecipientStillAllowed(row.delivery.recipient, config);
    const status = await runtimeStatus({ config, credentialProvider: this.credentialProvider, worker: this.worker, reviewedDelivery: this.reviewedDelivery, rateLimitAuthority: this.rateLimitAuthority });
    assertSendReady(status, { allowDryRun: true });
    const recipientAuthority = await this.#authorizeRecipient(row.delivery.recipient, "initial_confirmation");
    const validatedScheduledAt = row.delivery.kind === "scheduler"
      ? this.scheduler.validateStoredTime(row.delivery.scheduledAt, config)
      : null;
    const confirmation = this.confirmations.consume(confirmationId, pending.purpose);

    // Safety can only tighten between capture and click. A capture made while
    // dry, or a runtime switched back to dry before confirmation, never sends.
    if (row.delivery.dryRunAtCapture || config.dryRun) {
      const event = this.events.write("delivery.would_send", {
        clipId: row.clip.id,
        recipient: row.delivery.recipient,
        requestedDelivery: row.delivery.kind,
        scheduledAt: row.delivery.scheduledAt,
        reason: row.delivery.dryRunAtCapture ? "dry_run_at_capture" : "dry_run_now",
        confirmationId: confirmation.id,
      });
      return Object.freeze({ status: "would_send", eventId: event.id });
    }

    if (row.delivery.kind === "scheduler") {
      const job = this.scheduler.enqueue({
        clipId: row.clip.id,
        recipient: row.delivery.recipient,
        scheduledAt: validatedScheduledAt,
        initialConfirmationId: confirmation.id,
      });
      this.events.write("schedule.queued", { jobId: job.id, clipId: row.clip.id, recipient: job.recipient, scheduledAt: job.scheduledAt });
      return Object.freeze({ status: "scheduled", job });
    }
    return this.#sendConfirmed({ row, confirmation, config, recipientAuthority });
  }

  /**
   * A scheduler tick never sends. It only turns due jobs into a second,
   * explicit confirmation challenge for the Studio UI.
   */
  tickScheduler() {
    this.#assertStorage();
    this.scheduler.markDue();
    const jobs = this.scheduler.awaitingFireConfirmation();
    const challenges = [];
    for (const job of jobs) {
      if (job.fireConfirmationId) {
        try {
          challenges.push(this.confirmations.get(job.fireConfirmationId, "scheduled_fire"));
          continue;
        } catch (error) {
          if (!new Set(["confirmation_required", "confirmation_expired"]).has(error?.code)) throw error;
        }
      }
      const row = this.#captureRecord(job.clipId);
      const confirmation = this.confirmations.issue({
        purpose: "scheduled_fire",
        clipId: row.clip.id,
        delivery: "scheduler",
        scheduleId: job.id,
        ttlSeconds: 24 * 60 * 60,
        display: confirmationDisplay(row.clip, { recipient: job.recipient, channel: "imessage", scheduledAt: job.scheduledAt }),
      });
      this.scheduler.attachFireConfirmation(job.id, confirmation.id, { replacing: job.fireConfirmationId });
      this.events.write("schedule.awaiting_fire_confirmation", { jobId: job.id, clipId: row.clip.id, recipient: job.recipient, confirmationId: confirmation.id });
      challenges.push(confirmation);
    }
    return Object.freeze(challenges);
  }

  async confirmScheduledFire({ confirmationId, confirmedBy }) {
    this.#assertStorage();
    assertHumanConfirmation(confirmedBy);
    const pending = this.confirmations.get(confirmationId, "scheduled_fire");
    const row = this.#captureRecord(pending.clipId);
    if (!pending.scheduleId) throw codedError("schedule_state_invalid", "The fire confirmation has no scheduled job.");
    await assertClipFingerprint(row.clip, this.paths.artifactRoot, {
      requireThumbnail: row.delivery.kind !== "workflow" && row.delivery.dryRunAtCapture !== true,
    });
    const config = this.configStore.read();
    this.#assertRecipientStillAllowed(row.delivery.recipient, config);
    const status = await runtimeStatus({ config, credentialProvider: this.credentialProvider, worker: this.worker, reviewedDelivery: this.reviewedDelivery, rateLimitAuthority: this.rateLimitAuthority });
    assertSendReady(status, { allowDryRun: true });
    const recipientAuthority = await this.#authorizeRecipient(row.delivery.recipient, "scheduled_fire_confirmation");
    const confirmation = this.confirmations.consume(confirmationId, "scheduled_fire");
    const job = this.scheduler.claimForSend(pending.scheduleId, confirmation.id);

    if (row.delivery.dryRunAtCapture || config.dryRun) {
      const event = this.events.write("delivery.would_send", {
        jobId: job.id,
        clipId: row.clip.id,
        recipient: job.recipient,
        requestedDelivery: "scheduler",
        reason: row.delivery.dryRunAtCapture ? "dry_run_at_capture" : "dry_run_now",
        confirmationId: confirmation.id,
      });
      this.scheduler.complete(job.id, "would_send");
      return Object.freeze({ status: "would_send", eventId: event.id });
    }

    try {
      const outcome = await this.#sendConfirmed({ row, confirmation, config, recipientAuthority });
      this.scheduler.complete(job.id, "sent");
      return outcome;
    } catch (error) {
      this.scheduler.complete(job.id, "attention");
      throw error;
    }
  }

  recentCaptures(limit = 20) {
    this.#assertStorageIfPresent();
    const events = this.events.recent(500);
    const seen = new Set();
    const result = [];
    for (const event of events) {
      if (event.type !== "capture.completed" || !event.data?.clip?.id || seen.has(event.data.clip.id)) continue;
      seen.add(event.data.clip.id);
      const row = { clip: event.data.clip, delivery: event.data.delivery, recordedAt: event.at };
      result.push(Object.freeze({ ...row, deliveryStatus: latestDeliveryStatus(row, events) }));
      if (result.length >= Math.max(0, Math.min(20, Number(limit) || 20))) break;
    }
    return result;
  }

  recentEvents(limit = 20) {
    this.#assertStorageIfPresent();
    return this.events.recent(Math.max(0, Math.min(20, Number(limit) || 20)));
  }

  #pendingInitial(confirmationId) {
    for (const purpose of ["initial_send", "initial_schedule"]) {
      try {
        return this.confirmations.get(confirmationId, purpose);
      } catch (error) {
        if (error?.code !== "confirmation_required") throw error;
      }
    }
    throw codedError("confirmation_required", "Explicit human confirmation is required.");
  }

  async #sendConfirmed({ row, confirmation, config, recipientAuthority }) {
    await this.#reserveExistingRate("send", row.delivery.recipient, config);
    this.rateLimiter.reserve("send", row.delivery.recipient, config.rateLimits);
    try {
      const outcome = await this.reviewedDelivery.send({
        clip: row.clip,
        recipient: row.delivery.recipient,
        caption: row.delivery.caption,
        confirmation,
        idempotencyKey: deliveryIdempotencyKey(row.clip.id, row.delivery.recipient, confirmation.purpose),
        recipientAuthority,
      });
      const event = this.events.write("delivery.sent", {
        clipId: row.clip.id,
        recipient: row.delivery.recipient,
        messageId: outcome.messageId,
        deduplicated: outcome.deduplicated,
        confirmationId: confirmation.id,
      });
      return Object.freeze({ status: "sent", outcome, eventId: event.id });
    } catch (error) {
      this.events.write("delivery.unknown", {
        clipId: row.clip.id,
        recipient: row.delivery.recipient,
        confirmationId: confirmation.id,
        errorCode: safeError(error).code,
        automaticRetry: false,
      });
      throw error;
    }
  }

  #captureRecord(id) {
    const row = this.captures.get(id);
    if (!row) throw codedError("capture_missing", "The captured clip is no longer available.");
    return row;
  }

  #validateDelivery(request, config) {
    const kind = String(request?.delivery ?? "").trim().toLowerCase();
    if (!DELIVERY_KINDS.has(kind)) throw codedError("delivery_invalid", "Choose Workflow, Rico attachment, or Scheduler.");
    if (kind === "workflow") return Object.freeze({ kind, recipient: null, scheduledAt: null });
    const recipient = normalizeRecipient(request?.recipient);
    if (!config.allowedRecipients.includes(recipient)) throw codedError("recipient_not_allowlisted", "Choose a recipient from Rico's existing allowlist.");
    const scheduledAt = kind === "scheduler" ? this.scheduler.validateTime(request?.scheduledAt, config) : null;
    return Object.freeze({ kind, recipient, scheduledAt });
  }

  #validateAdvanced(input, config) {
    const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const format = String(value.format ?? "mp4").toLowerCase();
    if (format !== "mp4") throw codedError("capture_format_invalid", "Bad Rudy currently supports MP4 capture only.");
    const maxDurationSeconds = Number(value.maxDurationSeconds ?? config.maxDurationSeconds);
    if (!Number.isInteger(maxDurationSeconds) || maxDurationSeconds < 1 || maxDurationSeconds > config.maxDurationSeconds) throw codedError("capture_duration_invalid", "The duration cap must be within the configured limit.");
    const retries = Number(value.retries ?? config.maxRetries);
    if (!Number.isInteger(retries) || retries < 0 || retries > config.maxRetries) throw codedError("capture_retries_invalid", "The retry count exceeds the configured limit.");
    return Object.freeze({
      format,
      maxDurationSeconds,
      exportStill: value.exportStill == null ? config.stillFrameDefault : value.exportStill === true,
      retries,
    });
  }

  async #validateCaption(input) {
    const caption = String(input ?? "").trim();
    if (!caption) return "";
    if ([...caption].length > 500 || /[\r\n]/u.test(caption)) throw codedError("caption_invalid", "The optional caption must be one line of at most 500 characters.");
    const result = await this.promptFilter?.evaluate?.(caption, { feature: "bad-rudy-caption", source: "human:studio" });
    if (result?.allow !== true) throw codedError("caption_rejected", String(result?.publicReason || "The caption did not pass OpenClaw's safety review."));
    return caption;
  }

  #assertRecipientStillAllowed(recipient, config) {
    if (!recipient || !config.allowedRecipients.includes(normalizeRecipient(recipient))) {
      throw codedError("recipient_not_allowlisted", "The recipient is no longer in Rico's allowlist.");
    }
  }

  async #reserveExistingRate(kind, recipient, config) {
    if (!this.rateLimitAuthority || typeof this.rateLimitAuthority.reserve !== "function") {
      throw codedError("rate_limit_authority_unavailable", "Rico's existing global and per-recipient rate-limit authority is unavailable.");
    }
    let result;
    try {
      result = await this.rateLimitAuthority.reserve({
        feature: "bad-rudy",
        kind,
        recipient,
        source: "human:studio",
        at: this.now().toISOString(),
        configuredCeilings: config.rateLimits,
      });
    } catch (error) {
      throw codedError("rate_limit_authority_unavailable", "Rico's existing global and per-recipient rate-limit authority is unavailable.", error);
    }
    if (result?.approved !== true) throw codedError("rate_limit_denied", String(result?.publicReason || "Rico's existing rate limit denied this operation."));
    const policyVersion = String(result?.policyVersion ?? "").trim();
    const revision = normalizeAuthorityRevision(result?.revision);
    if (!policyVersion || !revision) throw codedError("rate_limit_authority_unavailable", "Rico's existing rate-limit authority returned no policy version or revision.");
    return Object.freeze({ approved: true, policyVersion, revision });
  }

  #ensureStorage() {
    ensurePrivateDirectoryChain(this.paths.home, this.paths.artifactRoot);
    ensurePrivateDirectoryChain(this.paths.home, this.paths.stateRoot);
  }

  #assertStorage() {
    assertPrivateDirectoryChain(this.paths.home, this.paths.artifactRoot);
    assertPrivateDirectoryChain(this.paths.home, this.paths.stateRoot);
  }

  #assertStorageIfPresent() {
    if (!fs.existsSync(this.paths.artifactRoot) && !fs.existsSync(this.paths.stateRoot)) return;
    this.#assertStorage();
  }

  async #authorizeRecipient(recipient, stage) {
    if (!this.rateLimitAuthority || typeof this.rateLimitAuthority.authorizeRecipient !== "function") {
      throw codedError("recipient_authority_unavailable", "Rico's live recipient authority is unavailable.");
    }
    let result;
    try {
      result = await this.rateLimitAuthority.authorizeRecipient({
        feature: "bad-rudy",
        recipient,
        channel: "imessage",
        stage,
        source: "human:studio",
        at: this.now().toISOString(),
      });
    } catch (error) {
      throw codedError("recipient_authority_unavailable", "Rico's live recipient authority is unavailable.", error);
    }
    if (result?.approved !== true) throw codedError("recipient_revoked", "Rico's live recipient policy no longer approves this recipient.");
    let authorizedRecipient;
    try {
      authorizedRecipient = normalizeRecipient(result?.recipient);
    } catch {
      throw codedError("recipient_authority_invalid", "Rico's live recipient authority returned an invalid recipient.");
    }
    const policyVersion = String(result?.policyVersion ?? "").trim();
    const revision = normalizeAuthorityRevision(result?.revision);
    if (authorizedRecipient !== normalizeRecipient(recipient) || !policyVersion || !revision) {
      throw codedError("recipient_authority_invalid", "Rico's live recipient authority did not bind the exact recipient, policy version, and revision.");
    }
    return Object.freeze({ recipient: authorizedRecipient, policyVersion, revision, stage });
  }
}

export function createBadRudyRuntime(options) {
  return new BadRudyRuntime(options);
}

function assertHumanConfirmation(value) {
  if (value !== "human:studio") throw codedError("confirmation_required", "Use the Studio Confirm send button to continue.");
}

function cryptoDigest(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function latestDeliveryStatus(row, events) {
  const matching = events.filter((event) => event?.data?.clipId === row.clip.id || event?.data?.clip?.id === row.clip.id);
  for (const event of matching) {
    if (event.type === "delivery.sent") return "sent";
    if (event.type === "delivery.unknown") return "attention";
    if (event.type === "delivery.would_send") return "would_send";
    if (event.type === "schedule.awaiting_fire_confirmation") return "awaiting_fire_confirmation";
    if (event.type === "schedule.queued") return "scheduled";
  }
  return row.delivery.kind === "workflow" ? "log_only" : "captured";
}

function normalizeAuthorityRevision(value) {
  if (Number.isInteger(value) && value >= 0) return String(value);
  const revision = typeof value === "string" ? value.trim() : "";
  return revision && revision.length <= 120 ? revision : "";
}
