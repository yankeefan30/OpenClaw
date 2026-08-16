import crypto from "node:crypto";
import { NEW_YORK_TIME_ZONE } from "./config.mjs";
import { LockedJsonStore } from "./stores.mjs";
import { codedError } from "./errors.mjs";

export class BadRudyScheduler {
  constructor(filePath, { now = () => new Date() } = {}) {
    this.store = new LockedJsonStore(filePath, { schema: "openclaw.bad-rudy-schedule/v1", jobs: [] });
    this.now = now;
  }

  validateTime(scheduledAt, config) {
    const raw = String(scheduledAt ?? "").trim();
    // Require an explicit Eastern offset rather than accepting a machine-local
    // or UTC interpretation of the datetime picker.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:-04:00|-05:00)$/u.test(raw)) {
      throw codedError("schedule_timezone_required", "Choose a time with an explicit America/New_York offset.");
    }
    const instant = new Date(raw);
    if (!Number.isFinite(instant.getTime()) || !offsetMatchesNewYork(raw, instant)) throw codedError("schedule_timezone_invalid", "The chosen time is not valid in America/New_York.");
    const leadSeconds = (instant.getTime() - this.now().getTime()) / 1_000;
    if (leadSeconds < config.scheduler.minLeadSeconds || leadSeconds > config.scheduler.maxLeadSeconds) {
      throw codedError("schedule_out_of_bounds", "Choose a send time from 2 minutes through 30 days from now.");
    }
    return instant.toISOString();
  }

  validateStoredTime(scheduledAt, config) {
    const instant = new Date(String(scheduledAt ?? ""));
    if (!Number.isFinite(instant.getTime())) throw codedError("schedule_timezone_invalid", "The stored schedule time is invalid.");
    const leadSeconds = (instant.getTime() - this.now().getTime()) / 1_000;
    if (leadSeconds < config.scheduler.minLeadSeconds || leadSeconds > config.scheduler.maxLeadSeconds) {
      throw codedError("schedule_out_of_bounds", "Choose a send time from 2 minutes through 30 days from now.");
    }
    return instant.toISOString();
  }

  enqueue({ clipId, recipient, scheduledAt, initialConfirmationId }) {
    const job = {
      id: crypto.randomUUID(),
      clipId,
      recipient,
      scheduledAt,
      timeZone: NEW_YORK_TIME_ZONE,
      initialConfirmationId,
      state: "scheduled",
      createdAt: this.now().toISOString(),
      fireConfirmationId: null,
    };
    this.store.update((state) => {
      assertState(state);
      state.jobs.push(job);
    });
    return Object.freeze({ ...job });
  }

  markDue() {
    const due = [];
    const now = this.now();
    this.store.update((state) => {
      assertState(state);
      for (const job of state.jobs) {
        if (job.state === "scheduled" && Date.parse(job.scheduledAt) <= now.getTime()) {
          job.state = "awaiting_fire_confirmation";
          job.dueAt = now.toISOString();
          due.push(structuredClone(job));
        }
      }
    });
    return due;
  }

  awaitingFireConfirmation() {
    const state = this.store.read();
    assertState(state);
    return state.jobs
      .filter((job) => job.state === "awaiting_fire_confirmation")
      .map((job) => structuredClone(job));
  }

  attachFireConfirmation(jobId, confirmationId, { replacing = null } = {}) {
    this.store.update((state) => {
      assertState(state);
      const job = state.jobs.find((item) => item.id === jobId);
      if (!job || job.state !== "awaiting_fire_confirmation" ||
          (replacing === null ? job.fireConfirmationId !== null : job.fireConfirmationId !== replacing)) {
        throw codedError("schedule_state_invalid", "The scheduled clip is not ready for fire confirmation.");
      }
      job.fireConfirmationId = confirmationId;
    });
  }

  claimForSend(jobId, confirmationId) {
    return this.store.update((state) => {
      assertState(state);
      const job = state.jobs.find((item) => item.id === jobId);
      if (!job || job.state !== "awaiting_fire_confirmation" || job.fireConfirmationId !== confirmationId) {
        throw codedError("schedule_state_invalid", "The scheduled clip does not match this confirmation.");
      }
      job.state = "sending";
      job.sendClaimedAt = this.now().toISOString();
      return structuredClone(job);
    });
  }

  complete(jobId, outcome) {
    this.store.update((state) => {
      assertState(state);
      const job = state.jobs.find((item) => item.id === jobId);
      if (!job || job.state !== "sending") throw codedError("schedule_state_invalid", "The scheduled clip is not in a send claim.");
      job.state = outcome === "sent" ? "sent" : outcome === "would_send" ? "would_send" : "attention";
      job.completedAt = this.now().toISOString();
    });
  }
}

function offsetMatchesNewYork(raw, instant) {
  const expected = raw.endsWith("-04:00") ? -240 : -300;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: NEW_YORK_TIME_ZONE, timeZoneName: "shortOffset" }).formatToParts(instant);
  const label = parts.find((part) => part.type === "timeZoneName")?.value ?? "";
  const match = label.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/u);
  if (!match) return false;
  const actual = (match[1] === "+" ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3] ?? 0));
  return actual === expected;
}

function assertState(state) {
  if (!state || state.schema !== "openclaw.bad-rudy-schedule/v1" || !Array.isArray(state.jobs)) throw codedError("schedule_state_invalid", "Bad Rudy's scheduler state is invalid.");
}
