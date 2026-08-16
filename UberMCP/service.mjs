import { CANCELLATION_NOTICE, RIDE_STATUSES, TERMINAL_RIDE_STATUSES } from "./constants.mjs";
import { governed } from "./errors.mjs";
import { requireApprovedGeocoder, validateAddressQuery, validateResolvedLocation, validateSearchCandidates } from "./geocoder.mjs";
import { verifyInvocationProof } from "./invocation-proof.mjs";
import {
  validateAddressSearchInput,
  validateCancelConfirmation,
  validateChallengeInput,
  validateConfirmationInput,
  validateEstimateInput,
  validateLocationResolveInput,
  validateRideRef,
} from "./validation.mjs";

export class GovernedUberService {
  constructor({ client, store, locationStore, geocoder, rateLimiter, now = () => new Date() } = {}) {
    if (!client || !store || !locationStore || !geocoder || !rateLimiter) throw governed("service_dependency_missing", "The governed Uber service is not fully configured.");
    this.client = client;
    this.store = store;
    this.locationStore = locationStore;
    this.geocoder = geocoder;
    this.rateLimiter = rateLimiter;
    this.now = now;
  }

  async status() {
    const client = await this.client.status();
    const geocoder = await this.geocoder.status().catch(() => ({ ready: false, approved: false, reason: "approved_geocoder_missing" }));
    let monitorCount = 0;
    let ledgerHealthy = false;
    try {
      this.store.ledger.readAll();
      monitorCount = this.store.listMonitoredRides().length;
      ledgerHealthy = true;
    } catch { /* fail closed */ }
    const enabled = client.enabled === true && ledgerHealthy && geocoder.ready === true && geocoder.approved === true;
    return Object.freeze({
      ok: true,
      enabled,
      environment: client.environment,
      keychain: client.keychain,
      privilegedRequestApproved: client.privilegedRequestApproved === true,
      scopes: client.scopes,
      paymentAliases: client.enabled ? ["personal", "business"] : [],
      geocoder: Object.freeze({ ready: geocoder.ready === true, approved: geocoder.approved === true, provider: geocoder.provider ?? null, reason: geocoder.reason ?? null }),
      ledgerHealthy,
      activeMonitors: monitorCount,
      officialApi: "Uber Riders API v1.2",
      browserAutomation: false,
      futureReservationsSupported: false,
      modelVisibleMonitorTool: false,
      ...(enabled ? {} : { disabledReason: client.reason ?? (ledgerHealthy ? (geocoder.ready ? "not_ready" : "approved_geocoder_missing") : "ledger_invalid") }),
    });
  }

  async locationSearch(args) {
    const { invocation_proof: proof, ...raw } = args;
    const input = validateAddressSearchInput(raw);
    const query = validateAddressQuery(input.query);
    return this.authorized(proof, "uber.location_search", raw, async (session, principal) => {
      const approval = await requireApprovedGeocoder(this.geocoder);
      this.rateLimiter.acquire("geocode");
      const candidates = validateSearchCandidates(await this.geocoder.search(query), approval.provider);
      const stored = this.locationStore.createCandidates({ query, ...approval, candidates, hmacKey: session.bundle.locationHmacKey });
      return Object.freeze({ ok: true, candidates: stored, sourceTrust: "untrusted_external_data", instruction: "Select one candidateRef; never infer coordinates." });
    });
  }

  async locationResolve(args) {
    const { invocation_proof: proof, ...raw } = args;
    const input = validateLocationResolveInput(raw);
    return this.authorized(proof, "uber.location_resolve", raw, async (session) => {
      const approval = await requireApprovedGeocoder(this.geocoder);
      const candidate = this.locationStore.readCandidate(input.candidateRef, session.bundle.locationHmacKey);
      if (candidate.provider !== approval.provider || candidate.approvalReference !== approval.approvalReference) throw governed("geocoder_approval_mismatch", "The location candidate belongs to a different geocoder approval.");
      this.rateLimiter.acquire("geocode");
      const resolved = validateResolvedLocation(await this.geocoder.resolve({ adapterRef: candidate.adapterRef, formattedAddress: candidate.formattedAddress }), approval.provider);
      const location = this.locationStore.createResolved({ candidate, resolved, hmacKey: session.bundle.locationHmacKey });
      return Object.freeze({ ok: true, ...location, sourceTrust: "untrusted_external_data" });
    });
  }

  async productsEstimate(args) {
    const { invocation_proof: proof, ...raw } = args;
    const input = validateEstimateInput(raw);
    return this.authorized(proof, "uber.products_estimate", raw, async (session, principal) => {
      const pickup = this.locationStore.readResolved(input.pickupLocationRef, session.bundle.locationHmacKey);
      const dropoff = this.locationStore.readResolved(input.dropoffLocationRef, session.bundle.locationHmacKey);
      if (pickup.latitude === dropoff.latitude && pickup.longitude === dropoff.longitude) throw governed("route_invalid", "Pickup and drop-off resolve to the same location.");
      const route = Object.freeze({ pickup, dropoff, productId: input.productId, seatCount: input.seatCount });
      const rawProducts = await session.products(pickup);
      const products = sanitizeProducts(rawProducts?.products);
      if (route.productId === null) {
        this.store.ledger.append("products.viewed", { principalBinding: principal.bindingDigest, count: products.length });
        return Object.freeze({ ok: true, mode: "products", products, pickupAddress: pickup.formattedAddress, sourceTrust: "untrusted_external_data" });
      }
      const product = products.find((candidate) => candidate.productId === route.productId);
      if (!product) throw governed("product_not_available", "The selected Uber product is not currently available at the pickup location.");
      if (product.upfrontFareEnabled !== true) throw governed("upfront_fare_required", "The selected Uber product does not support the required upfront fare flow.");
      const response = await session.estimate(route);
      const estimate = this.store.createEstimate({ principal, route: Object.freeze({ ...route, productDisplayName: product.displayName }), response });
      return Object.freeze({
        ok: true,
        mode: "estimate",
        estimateRef: estimate.id,
        product: product.displayName,
        fare: publicFare(estimate.fare),
        pickupEtaMinutes: estimate.pickupEstimateMinutes,
        trip: estimate.trip,
        pickupAddress: pickup.formattedAddress,
        dropoffAddress: dropoff.formattedAddress,
        expiresAt: estimate.expiresAt,
        sourceTrust: "untrusted_external_data",
      });
    });
  }

  async createReviewedChallenge(args) {
    const { invocation_proof: proof, ...raw } = args;
    const request = validateChallengeInput(raw, this.date());
    return this.authorized(proof, "uber.create_challenge", raw, async (_session, principal) => {
      const estimate = this.store.readEstimate(request.estimateRef, principal);
      const challenge = this.store.createRideChallenge({ estimate, principal, request });
      return Object.freeze({
        ok: true,
        challengeId: challenge.id,
        confirmation: challenge.challenge,
        expiresAt: challenge.expiresAt,
        review: Object.freeze({
          product: estimate.route.productDisplayName,
          pickup: estimate.route.pickup.formattedAddress,
          dropoff: estimate.route.dropoff.formattedAddress,
          scheduledFor: request.scheduledFor,
          paymentAlias: request.paymentAlias,
          fare: publicFare(estimate.fare),
          pickupEtaMinutes: estimate.pickupEstimateMinutes,
          trip: estimate.trip,
          cancellationTerms: CANCELLATION_NOTICE,
          businessExpenseMemo: request.paymentAlias === "business" ? request.expenseMemo : null,
        }),
        instruction: `Send a new iMessage containing exactly ${challenge.challenge} and nothing else before the fare expires.`,
      });
    });
  }

  async confirmRequest(args) {
    const { invocation_proof: proof, ...raw } = args;
    const confirmation = validateConfirmationInput(raw);
    return this.authorized(proof, "uber.confirm_request", raw, async (session, principal) => {
      const { challenge, estimate } = this.store.requireRideChallenge(confirmation.challengeId, principal);
      if (new Date(challenge.request.scheduledFor).getTime() > this.date().getTime() + 15_000) throw governed("dispatch_too_early", "This reviewed on-demand Uber request cannot be dispatched more than 15 seconds before its confirmed time.");
      const claim = this.store.reserveMutation("request", challenge.id, challenge.immutableDigest);
      if (!claim.newlyReserved) return this.replayClaim(claim);
      try {
        const response = await session.requestRide({
          productId: estimate.route.productId,
          fareId: estimate.fare.fareId,
          pickup: estimate.route.pickup,
          dropoff: estimate.route.dropoff,
          seatCount: estimate.route.seatCount,
          paymentAlias: challenge.request.paymentAlias,
          expenseCode: challenge.request.expenseCode,
          expenseMemo: challenge.request.expenseMemo,
        });
        const requestId = requiredApiId(response?.request_id, "request_id_missing");
        const status = optionalStatus(response?.status, "processing");
        const ride = this.store.createRide({ requestId, productId: estimate.route.productId, principalBinding: principal.bindingDigest, responseStatus: status });
        this.store.completeMutation(claim, "confirmed", { rideRef: ride.id, status });
        this.store.consumeChallenge("ride", challenge);
        return Object.freeze({ ok: true, requested: true, deduplicated: false, rideRef: ride.id, status, monitoring: ride.monitorActive, sourceTrust: "untrusted_external_data" });
      } catch (error) {
        const status = error?.code === "uber_api_rejected" || error?.code === "payment_alias_stale" ? "rejected" : "outcome-unknown";
        this.store.completeMutation(claim, status, { apiStatus: error?.details?.status ?? null });
        this.store.consumeChallenge("ride", challenge);
        if (status === "outcome-unknown") throw governed("uber_mutation_outcome_unknown", "The ride request outcome is unknown and quarantined. Rico will not retry it automatically.");
        throw error;
      }
    });
  }

  async currentStatus(args) {
    const { invocation_proof: proof, ...raw } = args;
    validateExactRideInput(raw);
    const rideRef = validateRideRef(raw.rideRef);
    return this.authorized(proof, "uber.current_status", raw, async (session, principal) => {
      const ride = this.store.readRide(rideRef, principal);
      const details = await session.requestDetails(ride.requestId);
      const updated = this.store.updateRide(ride.id, details);
      return Object.freeze({ ok: true, ...safeRideDetails(updated, details), sourceTrust: "untrusted_external_data" });
    });
  }

  async cancelPreview(args) {
    const { invocation_proof: proof, ...raw } = args;
    validateExactRideInput(raw);
    const rideRef = validateRideRef(raw.rideRef);
    return this.authorized(proof, "uber.cancel_preview", raw, async (session, principal) => {
      const ride = this.store.readRide(rideRef, principal);
      const details = await session.requestDetails(ride.requestId);
      const updated = this.store.updateRide(ride.id, details);
      if (TERMINAL_RIDE_STATUSES.has(updated.status)) throw governed("ride_terminal", "This Uber ride is already terminal and cannot be canceled.");
      const challenge = this.store.createCancelChallenge(updated, principal);
      return Object.freeze({
        ok: true,
        challengeId: challenge.id,
        confirmation: challenge.challenge,
        expiresAt: challenge.expiresAt,
        review: Object.freeze({ rideRef: updated.id, status: updated.status, cancellationTerms: challenge.cancellationNotice }),
        instruction: `Send a new iMessage containing exactly ${challenge.challenge} and nothing else to cancel this ride.`,
        sourceTrust: "untrusted_external_data",
      });
    });
  }

  async cancelConfirm(args) {
    const { invocation_proof: proof, ...raw } = args;
    const confirmation = validateCancelConfirmation(raw);
    return this.authorized(proof, "uber.cancel_confirm", raw, async (session, principal) => {
      const { challenge, ride } = this.store.requireCancelChallenge(confirmation.challengeId, principal);
      const claim = this.store.reserveMutation("cancel", challenge.id, challenge.requestDigest);
      if (!claim.newlyReserved) return this.replayClaim(claim);
      try {
        await session.cancelRide(ride.requestId);
        const updated = this.store.updateRide(ride.id, { status: "rider_canceled", pickup: { eta: ride.lastPickupEtaMinutes } });
        this.store.completeMutation(claim, "confirmed", { rideRef: ride.id, status: updated.status });
        this.store.consumeChallenge("cancel", challenge);
        return Object.freeze({ ok: true, canceled: true, deduplicated: false, rideRef: ride.id, status: updated.status });
      } catch (error) {
        const status = error?.code === "uber_api_rejected" ? "rejected" : "outcome-unknown";
        this.store.completeMutation(claim, status, { apiStatus: error?.details?.status ?? null });
        this.store.consumeChallenge("cancel", challenge);
        if (status === "outcome-unknown") throw governed("uber_mutation_outcome_unknown", "The ride cancellation outcome is unknown and quarantined. Rico will not retry it automatically.");
        throw error;
      }
    });
  }

  /** Internal scheduler seam; intentionally absent from MCP tools/list. */
  async monitorTick() {
    const monitored = this.store.listMonitoredRides();
    if (monitored.length === 0) return Object.freeze({ ok: true, checked: 0, enqueued: [] });
    return this.client.withSession(async (session) => {
      const enqueued = [];
      let checked = 0;
      for (const ride of monitored.slice(0, 20)) {
        let details;
        try { details = await session.requestDetails(ride.requestId, "monitor"); } catch {
          this.store.ledger.append("monitor.poll_failed", { rideRef: ride.id });
          continue;
        }
        checked += 1;
        const updated = this.store.updateRide(ride.id, details);
        if (!TERMINAL_RIDE_STATUSES.has(updated.status) && updated.lastPickupEtaMinutes !== null && updated.lastPickupEtaMinutes <= 3) {
          const result = this.store.enqueueArrivalAlert(updated.id);
          if (result.enqueued) enqueued.push(Object.freeze({ eventId: result.event.eventId, dedupeKey: result.event.dedupeKey }));
        }
      }
      return Object.freeze({ ok: true, checked, enqueued: Object.freeze(enqueued) });
    });
  }

  claimArrivalAlert(workerId, leaseMs) { return this.store.claimPendingAlert(workerId, leaseMs); }
  acknowledgeArrivalAlert(eventId, claimToken, deliveryId) { return this.store.acknowledgeAlert(eventId, claimToken, deliveryId); }
  releaseArrivalAlert(eventId, claimToken, errorCode) { return this.store.releaseAlert(eventId, claimToken, errorCode); }

  async authorized(proof, action, args, operation) {
    return this.client.withSession(async (session) => {
      const principal = verifyInvocationProof(proof, session.bundle.invocationHmacKey, { action, args }, this.date());
      this.store.consumeInvocation(principal);
      return operation(session, principal);
    });
  }

  replayClaim(claim) {
    if (claim.status === "confirmed") return Object.freeze({ ok: true, deduplicated: true, ...claim.evidence });
    if (claim.status === "rejected") throw governed("idempotent_action_rejected", "This Uber action was already definitively rejected; create a new reviewed challenge.");
    throw governed("uber_mutation_outcome_unknown", "This Uber action is reserved or outcome-unknown and cannot be retried automatically.");
  }

  date() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw governed("clock_invalid", "The Uber governance clock is invalid.");
    return date;
  }
}

function sanitizeProducts(value) {
  if (!Array.isArray(value)) throw governed("products_invalid", "Uber returned an invalid products list.");
  return Object.freeze(value.slice(0, 100).map((product) => Object.freeze({
    productId: requiredApiId(product?.product_id, "product_id_invalid"),
    displayName: safeText(product?.display_name, 1, 120, "product_name_invalid"),
    description: optionalText(product?.description, 300),
    capacity: optionalFinite(product?.capacity, 1, 100),
    upfrontFareEnabled: product?.upfront_fare_enabled === true,
  })));
}

function publicFare(fare) { return Object.freeze({ display: fare.display, currencyCode: fare.currencyCode, value: fare.value, expiresAt: fare.expiresAt }); }

function safeRideDetails(ride, details) {
  return {
    rideRef: ride.id,
    status: ride.status,
    pickupEtaMinutes: ride.lastPickupEtaMinutes,
    monitorActive: ride.monitorActive,
    driver: details?.driver ? Object.freeze({ name: optionalText(details.driver.name, 120), rating: optionalFinite(details.driver.rating, 0, 5) }) : null,
    vehicle: details?.vehicle ? Object.freeze({ make: optionalText(details.vehicle.make, 80), model: optionalText(details.vehicle.model, 80), licensePlate: optionalText(details.vehicle.license_plate, 40) }) : null,
  };
}

function validateExactRideInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join() !== "rideRef") throw governed("ride_input_invalid", "The Uber ride-status input is invalid.");
}

function requiredApiId(value, code) {
  if (typeof value !== "string" || value.length < 8 || value.length > 256 || /[^A-Za-z0-9_-]/u.test(value)) throw governed(code, "Uber returned an invalid identifier.");
  return value;
}

function optionalStatus(value, fallback) {
  const status = value === undefined || value === null ? fallback : safeText(value, 2, 80, "ride_status_invalid");
  if (!RIDE_STATUSES.has(status)) throw governed("ride_status_invalid", "Uber returned an unknown ride status.");
  return status;
}

function safeText(value, min, max, code) {
  if (typeof value !== "string" || value.length < min || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw governed(code, "Uber returned an invalid text field.");
  return value;
}

function optionalText(value, max) { return value === undefined || value === null ? null : safeText(value, 0, max, "uber_text_invalid"); }

function optionalFinite(value, min, max) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw governed("uber_number_invalid", "Uber returned an invalid numeric field.");
  return number;
}
