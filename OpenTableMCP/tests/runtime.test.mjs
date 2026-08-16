import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OpenTableRuntime } from "../runtime.mjs";
import { OpenTableStateStore } from "../state-store.mjs";
import { FIXED_NOW, HMAC_KEY, proof } from "./helpers.mjs";

test("booking requires preview, exact HOLD, separate exact BOOK, and terms acceptance", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ot-runtime-"));
  let now = new Date(FIXED_NOW);
  const session = new FakeSession();
  const runtime = runtimeWith(root, session, () => now);

  const preview = await runtime.bookingPreview({
    invocation_proof: proof("booking.preview", { now }),
    rid: 123,
    restaurant_name: "Reviewed Restaurant",
    date_time: "2026-08-16T19:00",
    party_size: 2,
    reservation_attribute: "default",
    cancellation_policy_id: "policy:v1",
    special_request: "Window if available",
  });
  assert.equal(preview.stage, "booking_preview");
  assert.match(preview.confirmationRequired, /^HOLD [0-9]{6}$/u);
  await assert.rejects(runtime.bookingHold({
    invocation_proof: proof("booking.hold", { now, messageBody: "HOLD 000000" }), preview_id: preview.previewId, confirmation: "HOLD 000000", acknowledge_policies: true,
  }), (error) => error.code === "inbound_message_challenge_mismatch");

  const holdMessage = "hold-message-main";
  const holdRun = "hold-run-main";
  const hold = await runtime.bookingHold({
    invocation_proof: proof("booking.hold", { now, message: holdMessage, messageBody: preview.confirmationRequired, run: holdRun }), preview_id: preview.previewId, confirmation: preview.confirmationRequired, acknowledge_policies: true,
  });
  assert.equal(hold.stage, "slot_held");
  assert.match(hold.confirmationRequired, /^BOOK [0-9]{6}$/u);
  assert.equal("reservationToken" in hold, false);
  assert.equal(session.calls.slotLock, 1);

  await assert.rejects(runtime.bookingConfirm({
    invocation_proof: proof("booking.confirm", { now }), hold_id: hold.holdId, confirmation: hold.confirmationRequired, accept_opentable_terms: false, accept_cancellation_policy: true,
  }), (error) => error.code === "terms_acceptance_required");

  await assert.rejects(runtime.bookingConfirm({
    invocation_proof: proof("booking.confirm", { now, message: holdMessage, messageBody: hold.confirmationRequired, run: "book-run-new-1" }), hold_id: hold.holdId, confirmation: hold.confirmationRequired, accept_opentable_terms: true, accept_cancellation_policy: true,
  }), (error) => error.code === "confirmation_message_reused");
  await assert.rejects(runtime.bookingConfirm({
    invocation_proof: proof("booking.confirm", { now, message: "book-message-new-1", messageBody: hold.confirmationRequired, run: holdRun }), hold_id: hold.holdId, confirmation: hold.confirmationRequired, accept_opentable_terms: true, accept_cancellation_policy: true,
  }), (error) => error.code === "same_run_chaining_blocked");
  await assert.rejects(runtime.bookingConfirm({
    invocation_proof: proof("booking.confirm", { now, message: "book-message-new-2", messageBody: `${hold.confirmationRequired}!`, run: "book-run-new-2" }), hold_id: hold.holdId, confirmation: hold.confirmationRequired, accept_opentable_terms: true, accept_cancellation_policy: true,
  }), (error) => error.code === "inbound_message_challenge_mismatch");
  assert.equal(session.calls.book, 0);

  const booked = await runtime.bookingConfirm({
    invocation_proof: proof("booking.confirm", { now, messageBody: hold.confirmationRequired }), hold_id: hold.holdId, confirmation: hold.confirmationRequired, accept_opentable_terms: true, accept_cancellation_policy: true,
  });
  assert.equal(booked.stage, "reservation_confirmed");
  assert.equal(booked.confirmationNumber, "777");
  assert.equal(session.calls.book, 1);
  const listed = await runtime.reservationsList({ invocation_proof: proof("reservation.list", { now }) });
  assert.equal(listed.reservations.length, 1);
  assert.equal(listed.reservations[0].reservationId, booked.reservationId);

  const cancelPreviewMessage = "cancel-preview-message-main";
  const cancelPreviewRun = "cancel-preview-run-main";
  const cancelPreview = await runtime.cancelPreview({ invocation_proof: proof("cancel.preview", { now, message: cancelPreviewMessage, run: cancelPreviewRun }), reservation_id: booked.reservationId });
  assert.match(cancelPreview.confirmationRequired, /^CANCEL [0-9]{6}$/u);
  await assert.rejects(runtime.cancelConfirm({
    invocation_proof: proof("cancel.confirm", { now, message: cancelPreviewMessage, messageBody: cancelPreview.confirmationRequired, run: "cancel-run-new-1" }), cancel_preview_id: cancelPreview.cancelPreviewId, confirmation: cancelPreview.confirmationRequired, acknowledge_cancellation: true,
  }), (error) => error.code === "confirmation_message_reused");
  await assert.rejects(runtime.cancelConfirm({
    invocation_proof: proof("cancel.confirm", { now, message: "cancel-message-new-1", messageBody: cancelPreview.confirmationRequired, run: cancelPreviewRun }), cancel_preview_id: cancelPreview.cancelPreviewId, confirmation: cancelPreview.confirmationRequired, acknowledge_cancellation: true,
  }), (error) => error.code === "same_run_chaining_blocked");
  await assert.rejects(runtime.cancelConfirm({
    invocation_proof: proof("cancel.confirm", { now, message: "cancel-message-new-2", messageBody: `Please ${cancelPreview.confirmationRequired}`, run: "cancel-run-new-2" }), cancel_preview_id: cancelPreview.cancelPreviewId, confirmation: cancelPreview.confirmationRequired, acknowledge_cancellation: true,
  }), (error) => error.code === "inbound_message_challenge_mismatch");
  assert.equal(session.calls.cancel, 0);
  const cancelled = await runtime.cancelConfirm({
    invocation_proof: proof("cancel.confirm", { now, messageBody: cancelPreview.confirmationRequired }), cancel_preview_id: cancelPreview.cancelPreviewId, confirmation: cancelPreview.confirmationRequired, acknowledge_cancellation: true,
  });
  assert.equal(cancelled.stage, "reservation_cancelled");
  assert.equal(session.calls.cancel, 1);
  assert.match(fs.readFileSync(path.join(root, "ledger.jsonl"), "utf8"), /reservation\.cancelled/u);
});

test("challenge is bound to the original iMessage conversation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ot-binding-"));
  const session = new FakeSession();
  const runtime = runtimeWith(root, session, () => FIXED_NOW);
  const preview = await runtime.bookingPreview({
    invocation_proof: proof("booking.preview", { conversation: "chat-a" }), rid: 123, restaurant_name: "Restaurant", date_time: "2026-08-16T19:00", party_size: 2,
  });
  await assert.rejects(runtime.bookingHold({
    invocation_proof: proof("booking.hold", { conversation: "chat-b", messageBody: preview.confirmationRequired }), preview_id: preview.previewId, confirmation: preview.confirmationRequired, acknowledge_policies: true,
  }), (error) => error.code === "challenge_principal_mismatch");
  assert.equal(session.calls.slotLock, 0);
});

test("HOLD proof must come from a new inbound message, a new run, and an exact entire body", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ot-fresh-message-"));
  const session = new FakeSession();
  const runtime = runtimeWith(root, session, () => FIXED_NOW);
  const sourceMessage = "message-source";
  const sourceRun = "run-source";
  const preview = await runtime.bookingPreview({
    invocation_proof: proof("booking.preview", { message: sourceMessage, messageBody: "book a table", run: sourceRun }),
    rid: 123, restaurant_name: "Restaurant", date_time: "2026-08-16T19:00", party_size: 2,
  });

  await assert.rejects(runtime.bookingHold({
    invocation_proof: proof("booking.hold", { message: sourceMessage, messageBody: preview.confirmationRequired, run: "run-new-1" }),
    preview_id: preview.previewId, confirmation: preview.confirmationRequired, acknowledge_policies: true,
  }), (error) => error.code === "confirmation_message_reused");

  await assert.rejects(runtime.bookingHold({
    invocation_proof: proof("booking.hold", { message: "message-new-1", messageBody: preview.confirmationRequired, run: sourceRun }),
    preview_id: preview.previewId, confirmation: preview.confirmationRequired, acknowledge_policies: true,
  }), (error) => error.code === "same_run_chaining_blocked");

  await assert.rejects(runtime.bookingHold({
    invocation_proof: proof("booking.hold", { message: "message-new-2", messageBody: `${preview.confirmationRequired} please`, run: "run-new-2" }),
    preview_id: preview.previewId, confirmation: preview.confirmationRequired, acknowledge_policies: true,
  }), (error) => error.code === "inbound_message_challenge_mismatch");
  assert.equal(session.calls.slotLock, 0);

  const held = await runtime.bookingHold({
    invocation_proof: proof("booking.hold", { message: "message-new-3", messageBody: `  ${preview.confirmationRequired}\r\n`, run: "run-new-3" }),
    preview_id: preview.previewId, confirmation: preview.confirmationRequired, acknowledge_policies: true,
  });
  assert.equal(held.stage, "slot_held");
  assert.equal(session.calls.slotLock, 1);
});

test("deposit/card-hold policy is redirected to official OpenTable instead of collecting payment", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ot-payment-"));
  const session = new FakeSession();
  session.availabilityPolicyId = "deposit:v1";
  session.cancellationPolicyResult = { policyType: "Deposit", depositDetails: { amount: 5000, denominator: 100, currency: "USD", type: "PerGuest" }, cutOff: { cutoffType: "DaysBefore", daysBeforeCutoff: 2 } };
  const runtime = runtimeWith(root, session, () => FIXED_NOW);
  await assert.rejects(runtime.bookingPreview({
    invocation_proof: proof("booking.preview"), rid: 123, restaurant_name: "Restaurant", date_time: "2026-08-16T19:00", party_size: 2, cancellation_policy_id: "deposit:v1",
  }), (error) => error.code === "payment_policy_unsupported" && error.details.officialSearchUrl.startsWith("https://www.opentable.com/"));
  assert.equal(session.calls.slotLock, 0);
  assert.equal(session.calls.book, 0);
});

test("restaurant discovery returns official link without credentials, proof, scraping, or network", async () => {
  let sessionCalled = false;
  const client = {
    status: async () => ({ keychain: { available: false }, enabled: false, reason: "keychain_missing", capabilities: [] }),
    withSession: async () => { sessionCalled = true; throw new Error("must not call"); },
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ot-link-"));
  const runtime = new OpenTableRuntime({ client, store: new OpenTableStateStore(root, () => FIXED_NOW), now: () => FIXED_NOW });
  const result = await runtime.restaurantSearch({ query: "Italian near Central Park" });
  assert.equal(result.mode, "official_link");
  assert.match(result.officialSearchUrl, /^https:\/\/www\.opentable\.com\/s\?/u);
  assert.equal(sessionCalled, false);
});

function runtimeWith(root, session, now) {
  const client = {
    status: async () => ({ keychain: { available: true }, enabled: true, environment: "production", apiFamily: "consumer-v2", capabilities: session.bundle.approval.approvedCapabilities, dinerProfileReady: true }),
    withSession: async (operation) => operation(session),
  };
  return new OpenTableRuntime({ client, store: new OpenTableStateStore(root, now), now });
}

class FakeSession {
  constructor() {
    this.bundle = {
      invocationHmacKey: HMAC_KEY,
      approval: { approvedCapabilities: ["directory", "availability", "booking_policy", "cancellation_policy", "slot_lock", "book", "get_reservation", "cancel"] },
    };
    this.calls = { slotLock: 0, book: 0, cancel: 0 };
    this.availabilityPolicyId = "policy:v1";
    this.cancellationPolicyResult = { policyType: "None", cutOff: { cutoffType: "CancellableAnytime" } };
  }

  requireCapability(capability) {
    if (!this.bundle.approval.approvedCapabilities.includes(capability)) throw Object.assign(new Error("not approved"), { code: "capability_not_approved" });
  }

  async bookingPolicies() { return { Policies: [{ Message: "Please arrive on time." }] }; }
  async availability(input) {
    return {
      times_available: [{
        time: input.startDateTime,
        availability_types: [{
          type: "Standard",
          cancellation_policy: input.startDateTime === "2026-08-16T19:00" ? { id: this.availabilityPolicyId, type: "None" } : null,
          dining_area: [],
        }],
      }],
    };
  }
  async cancellationPolicy() { return this.cancellationPolicyResult; }
  async createSlotLock() { this.calls.slotLock += 1; return { reservation_token: "remote-reservation-token-secret", expires_at: "2026-08-15T16:04:00.000Z" }; }
  async makeReservation() {
    this.calls.book += 1;
    return { confirmation_number: 777, date_time: "2026-08-16T19:00", party_size: 2, manage_reservation_url: "https://www.opentable.com/booking/777", cancel_cutoff_date_utc: "2026-08-16T17:00:00.000Z", message: "Ten minute grace period." };
  }
  async getReservation() { return { status: "Pending", date_time: "2026-08-16T19:00", party_size: 2, cancel_cutoff_date_utc: "2026-08-16T17:00:00.000Z" }; }
  async cancelReservation() { this.calls.cancel += 1; return {}; }
}
