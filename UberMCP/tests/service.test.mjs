import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LOCATION_KEY, KEY, withProof } from "./helpers.mjs";
import { PrivateLocationStore } from "../location-store.mjs";
import { GovernedUberService } from "../service.mjs";
import { UberStateStore } from "../state-store.mjs";

test("server geocodes to opaque refs, confirms on a new exact message, and enqueues one alert", async (t) => {
  const fx = fixture(t);
  const pickup = await resolvedRef(fx, "1 Main Street, New York, NY", "pickup");
  const dropoff = await resolvedRef(fx, "2 Broadway, New York, NY", "dropoff");
  assert.match(pickup.locationRef, /^location_/u);
  assert.equal(JSON.stringify(pickup).includes("40.75"), false);

  const estimateArgs = { pickupLocationRef: pickup.locationRef, dropoffLocationRef: dropoff.locationRef, productId: "product-uber-black", seatCount: 1 };
  const estimate = await fx.service.productsEstimate(proved("uber.products_estimate", estimateArgs, fx, "estimate"));
  const challengeArgs = { estimateRef: estimate.estimateRef, paymentAlias: "business", scheduledFor: fx.now().toISOString(), expenseCode: "CLIENT", expenseMemo: "Client travel" };
  const reviewed = await fx.service.createReviewedChallenge(proved("uber.create_challenge", challengeArgs, fx, "challenge-origin"));
  assert.match(reviewed.confirmation, /^RIDE \d{6}$/u);

  const confirmArgs = { challengeId: reviewed.challengeId };
  const requested = await fx.service.confirmRequest(proved("uber.confirm_request", confirmArgs, fx, "challenge-confirm", reviewed.confirmation));
  assert.equal(requested.requested, true);
  assert.equal(fx.session.requestCount, 1);

  const tick = await fx.service.monitorTick();
  assert.equal(tick.enqueued.length, 1);
  assert.equal((await fx.service.monitorTick()).enqueued.length, 0);
  const claim = fx.service.claimArrivalAlert("rico-imessage-delivery", 60_000);
  assert.equal(claim.event.pickupEtaMinutes, 3);
  const ack = fx.service.acknowledgeArrivalAlert(claim.event.eventId, claim.claimToken, "imessage-delivery-1");
  assert.equal(ack.delivered, true);
  assert.equal(fx.service.claimArrivalAlert("rico-imessage-delivery", 60_000), null);
  assert.equal(fx.store.ledger.readAll().filter((event) => event.type === "alert.enqueued").length, 1);
  assert.equal(fx.store.ledger.readAll().filter((event) => event.type === "alert.delivered").length, 1);
});

test("same message/run or non-exact challenge body cannot request a ride", async (t) => {
  const fx = fixture(t);
  const { reviewed, originSequence } = await createChallenge(fx);
  const args = { challengeId: reviewed.challengeId };
  await assert.rejects(fx.service.confirmRequest(withProof("uber.confirm_request", args, {
    clock: fx.now(), messageBody: reviewed.confirmation,
    messageId: `message-challenge-origin-${originSequence}`,
    runId: `run-challenge-origin-${originSequence}`,
    toolCallId: "tool-confirm-same-origin",
  })), { code: "confirmation_message_not_new" });
  const fx2 = fixture(t);
  const { reviewed: reviewed2 } = await createChallenge(fx2);
  const args2 = { challengeId: reviewed2.challengeId };
  await assert.rejects(fx2.service.confirmRequest(proved("uber.confirm_request", args2, fx2, "new-message", `${reviewed2.confirmation} please`)), { code: "confirmation_message_mismatch" });
  assert.equal(fx.session.requestCount + fx2.session.requestCount, 0);
});

test("proof replay is consumed before a second tool call", async (t) => {
  const fx = fixture(t);
  const args = { query: "1 Main Street, New York, NY" };
  const call = proved("uber.location_search", args, fx, "replay");
  await fx.service.locationSearch(call);
  await assert.rejects(fx.service.locationSearch(call), { code: "invocation_proof_replayed" });
  assert.equal(fx.geocoder.searchCount, 1);
});

test("server-generated mutation claim quarantines unknown outcome without caller idempotency", async (t) => {
  const fx = fixture(t);
  fx.session.requestError = Object.assign(new Error("unknown"), { code: "uber_mutation_outcome_unknown" });
  const { reviewed } = await createChallenge(fx);
  const args = { challengeId: reviewed.challengeId };
  await assert.rejects(fx.service.confirmRequest(proved("uber.confirm_request", args, fx, "confirm-unknown", reviewed.confirmation)), { code: "uber_mutation_outcome_unknown" });
  assert.equal(fx.session.requestCount, 1);
  const claims = fs.readdirSync(path.join(fx.directory, "claims"));
  assert.equal(claims.length, 1);
  assert.equal(JSON.stringify(fx.store.ledger.readAll()).includes("idempotencyKey"), false);
});

test("failed alert delivery releases with backoff and can be claimed then acknowledged", async (t) => {
  const fx = fixture(t);
  const { reviewed } = await createChallenge(fx);
  const args = { challengeId: reviewed.challengeId };
  await fx.service.confirmRequest(proved("uber.confirm_request", args, fx, "confirm-alert", reviewed.confirmation));
  await fx.service.monitorTick();
  const first = fx.service.claimArrivalAlert("worker-one", 60_000);
  const released = fx.service.releaseArrivalAlert(first.event.eventId, first.claimToken, "imessage_unavailable");
  assert.equal(released.released, true);
  assert.equal(fx.service.claimArrivalAlert("worker-one", 60_000), null);
  fx.advance(6_000);
  const retry = fx.service.claimArrivalAlert("worker-one", 60_000);
  assert.equal(retry.attempt, 2);
  fx.service.acknowledgeArrivalAlert(retry.event.eventId, retry.claimToken, "delivery-two");
  assert.equal(fx.service.claimArrivalAlert("worker-one", 60_000), null);
});

test("cancellation also requires a separate new exact CANCEL message", async (t) => {
  const fx = fixture(t, { pickupEta: 8 });
  const { reviewed } = await createChallenge(fx);
  const requestArgs = { challengeId: reviewed.challengeId };
  const requested = await fx.service.confirmRequest(proved("uber.confirm_request", requestArgs, fx, "ride-confirm", reviewed.confirmation));
  const previewArgs = { rideRef: requested.rideRef };
  const preview = await fx.service.cancelPreview(proved("uber.cancel_preview", previewArgs, fx, "cancel-origin"));
  const cancelArgs = { challengeId: preview.challengeId };
  const canceled = await fx.service.cancelConfirm(proved("uber.cancel_confirm", cancelArgs, fx, "cancel-confirm", preview.confirmation));
  assert.equal(canceled.canceled, true);
  assert.equal(fx.session.cancelCount, 1);
});

async function createChallenge(fx) {
  const pickup = await resolvedRef(fx, "1 Main Street, New York, NY", `pickup-${fx.sequence}`);
  const dropoff = await resolvedRef(fx, "2 Broadway, New York, NY", `dropoff-${fx.sequence}`);
  const estimateArgs = { pickupLocationRef: pickup.locationRef, dropoffLocationRef: dropoff.locationRef, productId: "product-uber-black", seatCount: 1 };
  const estimate = await fx.service.productsEstimate(proved("uber.products_estimate", estimateArgs, fx, "estimate"));
  const challengeArgs = { estimateRef: estimate.estimateRef, paymentAlias: "personal", scheduledFor: fx.now().toISOString(), expenseCode: null, expenseMemo: null };
  const reviewed = await fx.service.createReviewedChallenge(proved("uber.create_challenge", challengeArgs, fx, "challenge-origin"));
  return { estimate, reviewed, originSequence: fx.sequence };
}

async function resolvedRef(fx, query, label) {
  const searchArgs = { query };
  const search = await fx.service.locationSearch(proved("uber.location_search", searchArgs, fx, `${label}-search`));
  const resolveArgs = { candidateRef: search.candidates[0].candidateRef };
  return fx.service.locationResolve(proved("uber.location_resolve", resolveArgs, fx, `${label}-resolve`));
}

function proved(action, args, fx, label, messageBody = "@rico uber request") {
  fx.sequence += 1;
  return withProof(action, args, {
    clock: fx.now(),
    messageBody,
    messageId: `message-${label}-${fx.sequence}`,
    runId: `run-${label}-${fx.sequence}`,
    toolCallId: `tool-${label}-${fx.sequence}`,
  });
}

function fixture(t, { status = "accepted", pickupEta = 3 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-uber-service-"));
  t.after(() => {
    if (!directory.startsWith(path.join(os.tmpdir(), "openclaw-uber-service-"))) throw new Error("unsafe temp path");
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let clock = new Date();
  const now = () => new Date(clock);
  const store = new UberStateStore(directory, now);
  const locationStore = new PrivateLocationStore({ directory, ledger: store.ledger, now });
  const session = new FakeSession({ status, pickupEta, now });
  const client = {
    status: async () => ({ enabled: true, environment: "sandbox", scopes: ["request"], privilegedRequestApproved: true, keychain: { available: true } }),
    withSession: async (operation) => operation(session),
  };
  const geocoder = new FakeGeocoder(now);
  const rateLimiter = { acquire() { return { remaining: 10 }; } };
  const service = new GovernedUberService({ client, store, locationStore, geocoder, rateLimiter, now });
  return { directory, service, store, locationStore, session, geocoder, rateLimiter, now, advance(ms) { clock = new Date(clock.getTime() + ms); }, sequence: 0 };
}

class FakeGeocoder {
  constructor(now) { this.now = now; this.searchCount = 0; }
  async status() { return { ready: true, approved: true, serverSide: true, provider: "approved-test-map", approvalReference: "approval-test-123" }; }
  async search(query) { this.searchCount += 1; return [{ provider: "approved-test-map", adapterRef: `adapter-${Buffer.from(query).toString("base64url")}`, formattedAddress: query }]; }
  async resolve(candidate) {
    const pickup = candidate.formattedAddress.startsWith("1");
    return { provider: "approved-test-map", adapterRef: candidate.adapterRef, formattedAddress: candidate.formattedAddress, latitude: pickup ? 40.75 : 40.71, longitude: pickup ? -73.99 : -74.01, precision: "address", resolvedAt: new Date().toISOString() };
  }
}

class FakeSession {
  constructor({ status, pickupEta, now }) {
    this.bundle = { invocationHmacKey: KEY, locationHmacKey: LOCATION_KEY };
    this.status = status; this.pickupEta = pickupEta; this.now = now;
    this.requestCount = 0; this.detailsCount = 0; this.cancelCount = 0; this.requestError = null;
  }
  async products() { return { products: [{ product_id: "product-uber-black", display_name: "Uber Black", description: "Premium ride", capacity: 4, upfront_fare_enabled: true }] }; }
  async estimate() { return { fare: { value: 31.42, fare_id: "fare-secret-opaque", expires_at: Math.floor((this.now().getTime() + 120_000) / 1000), display: "$31.42", currency_code: "USD" }, trip: { duration_estimate: 900, distance_estimate: 6.5, distance_unit: "mile" }, pickup_estimate: 5 }; }
  async requestRide() { this.requestCount += 1; if (this.requestError) throw this.requestError; return { request_id: "request-official-123", status: "processing" }; }
  async requestDetails() { this.detailsCount += 1; return { status: this.status, pickup: { eta: this.pickupEta }, driver: { name: "Driver", rating: 4.9 }, vehicle: { make: "Vehicle", model: "Model", license_plate: "PLATE" } }; }
  async cancelRide() { this.cancelCount += 1; return {}; }
}
