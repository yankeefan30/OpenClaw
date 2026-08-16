import fs from "node:fs";
import path from "node:path";
import { randomChallenge, randomId, sha256 } from "./canonical.mjs";
import { CANCELLATION_NOTICE, RIDE_STATUSES, TERMINAL_RIDE_STATUSES } from "./constants.mjs";
import { governed } from "./errors.mjs";
import { HashChainedLedger, ensurePrivateDirectory, readPrivateJson, safeRecordPath, writePrivateJson } from "./private-store.mjs";

const UUID = /^[a-f0-9-]{36}$/u;

export class UberStateStore {
  constructor(directory, now = () => new Date()) {
    this.directory = ensurePrivateDirectory(path.resolve(directory));
    this.now = now;
    this.ledger = new HashChainedLedger(path.join(this.directory, "ledger.jsonl"), now);
    for (const child of ["estimates", "ride-challenges", "cancel-challenges", "rides", "claims", "proof-claims", "outbox"]) {
      ensurePrivateDirectory(path.join(this.directory, child));
    }
    this.ledger.readAll();
  }

  createEstimate({ principal, route, response }) {
    const fare = normalizeFare(response?.fare);
    const id = randomId();
    const record = {
      schema: "openclaw.uber.estimate",
      version: 1,
      id,
      status: "active",
      createdAt: this.timestamp(),
      expiresAt: fare.expiresAt,
      principalBinding: principal.bindingDigest,
      originMessageIdDigest: principal.messageIdDigest,
      originRunIdDigest: principal.runIdDigest,
      route,
      fare,
      trip: normalizeTrip(response?.trip),
      pickupEstimateMinutes: optionalNumber(response?.pickup_estimate, 0, 240),
    };
    if (new Date(record.expiresAt) <= this.date()) throw governed("fare_expired", "Uber returned an already-expired fare.");
    writePrivateJson(this.path("estimates", id), record, { exclusive: true });
    this.ledger.append("estimate.created", {
      estimateRef: id,
      principalBinding: principal.bindingDigest,
      routeDigest: sha256(route),
      productDigest: sha256(route.productId),
      fareExpiresAt: record.expiresAt,
    });
    return Object.freeze(record);
  }

  readEstimate(id, principal) {
    const record = validateEstimate(readPrivateJson(this.path("estimates", id)));
    if (record.principalBinding !== principal.bindingDigest) throw governed("estimate_principal_mismatch", "This Uber estimate belongs to a different iMessage principal or conversation.");
    if (new Date(record.expiresAt) <= this.date()) throw governed("fare_expired", "The Uber upfront fare has expired; request a fresh estimate.");
    return Object.freeze(record);
  }

  createRideChallenge({ estimate, principal, request }) {
    const now = this.date();
    const expiresAt = new Date(Math.min(new Date(estimate.expiresAt).getTime(), now.getTime() + 90_000)).toISOString();
    if (new Date(expiresAt).getTime() <= now.getTime() + 5_000) throw governed("fare_expiring", "The Uber upfront fare is too close to expiry; request a fresh estimate.");
    const id = randomId();
    const record = {
      schema: "openclaw.uber.ride-challenge",
      version: 1,
      id,
      status: "active",
      createdAt: this.timestamp(),
      expiresAt,
      consumedAt: null,
      challenge: randomChallenge("RIDE"),
      principalBinding: principal.bindingDigest,
      originMessageIdDigest: principal.messageIdDigest,
      originRunIdDigest: principal.runIdDigest,
      estimateRef: estimate.id,
      request,
      immutableDigest: sha256({ estimateRef: estimate.id, request, route: estimate.route, fare: estimate.fare }),
    };
    writePrivateJson(this.path("ride-challenges", id), record, { exclusive: true });
    this.ledger.append("ride.challenge.created", {
      challengeId: id,
      estimateRef: estimate.id,
      principalBinding: principal.bindingDigest,
      immutableDigest: record.immutableDigest,
      expiresAt,
      paymentAlias: request.paymentAlias,
    });
    return Object.freeze(record);
  }

  requireRideChallenge(id, principal) {
    const record = validateChallenge(readPrivateJson(this.path("ride-challenges", id)), "ride");
    this.requireChallengeActive(record, principal);
    const estimate = this.readEstimate(record.estimateRef, principal);
    if (record.immutableDigest !== sha256({ estimateRef: estimate.id, request: record.request, route: estimate.route, fare: estimate.fare })) {
      throw governed("challenge_tampered", "The immutable Uber ride preview failed integrity verification.");
    }
    return Object.freeze({ challenge: record, estimate });
  }

  consumeChallenge(kind, record) {
    const directory = kind === "ride" ? "ride-challenges" : "cancel-challenges";
    const current = readPrivateJson(this.path(directory, record.id));
    if (current.status !== "active") return Object.freeze(current);
    const next = { ...current, status: "consumed", consumedAt: this.timestamp() };
    writePrivateJson(this.path(directory, record.id), next);
    this.ledger.append(`${kind}.challenge.consumed`, { challengeId: record.id });
    return Object.freeze(next);
  }

  reserveMutation(kind, challengeId, payloadDigest) {
    if (!new Set(["request", "cancel"]).has(kind)) throw governed("mutation_kind_invalid", "The Uber mutation kind is invalid.");
    if (!UUID.test(String(challengeId ?? ""))) throw governed("challenge_id_invalid", "The Uber mutation challenge is invalid.");
    const keyDigest = sha256({ kind, challengeId, payloadDigest });
    const filePath = path.join(this.directory, "claims", `${keyDigest}.json`);
    const claim = {
      schema: "openclaw.uber.mutation-claim",
      version: 1,
      kind,
      keyDigest,
      payloadDigest,
      status: "reserved",
      reservedAt: this.timestamp(),
      completedAt: null,
      evidence: {},
    };
    try {
      writePrivateJson(filePath, claim, { exclusive: true });
      this.ledger.append("mutation.reserved", { kind, keyDigest, payloadDigest });
      return Object.freeze({ ...claim, newlyReserved: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = readPrivateJson(filePath);
      if (existing.payloadDigest !== payloadDigest) throw governed("idempotency_key_conflict", "That Uber idempotency key was already bound to a different reviewed action.");
      return Object.freeze({ ...existing, newlyReserved: false });
    }
  }

  consumeInvocation(principal) {
    const id = principal.toolCallIdDigest;
    if (!/^[a-f0-9]{64}$/u.test(String(id ?? ""))) throw governed("invocation_claim_invalid", "The Uber invocation claim is invalid.");
    const filePath = path.join(this.directory, "proof-claims", `${id}.json`);
    const record = {
      schema: "openclaw.uber.proof-claim",
      version: 1,
      toolCallIdDigest: id,
      nonceDigest: principal.nonceDigest,
      messageIdDigest: principal.messageIdDigest,
      runIdDigest: principal.runIdDigest,
      action: principal.action,
      consumedAt: this.timestamp(),
      expiresAt: principal.expiresAt,
    };
    try {
      writePrivateJson(filePath, record, { exclusive: true });
    } catch (error) {
      if (error?.code === "EEXIST") throw governed("invocation_proof_replayed", "This Uber tool-call proof has already been consumed.");
      throw error;
    }
    this.ledger.append("invocation.consumed", { toolCallIdDigest: id, messageIdDigest: principal.messageIdDigest, runIdDigest: principal.runIdDigest, action: principal.action });
    return Object.freeze(record);
  }

  completeMutation(claim, status, evidence = {}) {
    if (!new Set(["confirmed", "rejected", "outcome-unknown"]).has(status)) throw governed("mutation_status_invalid", "The Uber mutation outcome is invalid.");
    const filePath = path.join(this.directory, "claims", `${claim.keyDigest}.json`);
    const current = readPrivateJson(filePath);
    if (current.status !== "reserved") return Object.freeze(current);
    const next = { ...current, status, completedAt: this.timestamp(), evidence };
    writePrivateJson(filePath, next);
    this.ledger.append(`mutation.${status}`, { kind: current.kind, keyDigest: current.keyDigest, ...safeEvidence(evidence) });
    return Object.freeze(next);
  }

  createRide({ requestId, productId, principalBinding, responseStatus }) {
    const id = randomId();
    const now = this.timestamp();
    const record = {
      schema: "openclaw.uber.ride",
      version: 1,
      id,
      requestId,
      productId,
      principalBinding,
      status: responseStatus,
      createdAt: now,
      updatedAt: now,
      terminalAt: TERMINAL_RIDE_STATUSES.has(responseStatus) ? now : null,
      monitorActive: !TERMINAL_RIDE_STATUSES.has(responseStatus),
      arrivalAlertEnqueuedAt: null,
      lastPickupEtaMinutes: null,
    };
    writePrivateJson(this.path("rides", id), record, { exclusive: true });
    this.ledger.append("ride.created", { rideRef: id, requestDigest: sha256(requestId), productDigest: sha256(productId), status: responseStatus });
    return Object.freeze(record);
  }

  readRide(id, principal = null) {
    const record = validateRide(readPrivateJson(this.path("rides", id)));
    if (principal && record.principalBinding !== principal.bindingDigest) throw governed("ride_principal_mismatch", "This Uber ride belongs to a different iMessage principal or conversation.");
    return Object.freeze(record);
  }

  listMonitoredRides() {
    const directory = path.join(this.directory, "rides");
    return fs.readdirSync(directory)
      .filter((name) => /^[a-f0-9-]{36}\.json$/u.test(name))
      .map((name) => this.readRide(name.slice(0, -5)))
      .filter((record) => record.monitorActive && record.arrivalAlertEnqueuedAt === null);
  }

  updateRide(id, details) {
    const current = this.readRide(id);
    const status = normalizeRideStatus(details?.status);
    const eta = details?.pickup?.eta === undefined || details?.pickup?.eta === null ? null : optionalNumber(details.pickup.eta, 0, 240);
    const now = this.timestamp();
    const terminal = TERMINAL_RIDE_STATUSES.has(status);
    const next = {
      ...current,
      status,
      updatedAt: now,
      terminalAt: terminal ? (current.terminalAt ?? now) : null,
      monitorActive: terminal ? false : current.monitorActive,
      lastPickupEtaMinutes: eta,
    };
    writePrivateJson(this.path("rides", id), next);
    this.ledger.append("ride.status", { rideRef: id, status, pickupEtaMinutes: eta, terminal });
    return Object.freeze(next);
  }

  enqueueArrivalAlert(id) {
    const current = this.readRide(id);
    if (current.arrivalAlertEnqueuedAt !== null) return Object.freeze({ ride: current, enqueued: false });
    if (current.lastPickupEtaMinutes === null || current.lastPickupEtaMinutes > 3) throw governed("arrival_threshold_not_met", "The Uber driver is not yet within the three-minute alert threshold.");
    const at = this.timestamp();
    const eventId = randomId();
    const event = Object.freeze({
      schema: "openclaw.uber.alert",
      version: 1,
      eventId,
      type: "driver_arrival_threshold",
      source: "uber:riders-api-v1.2",
      rideRef: id,
      pickupEtaMinutes: current.lastPickupEtaMinutes,
      rideStatus: current.status,
      createdAt: at,
      dedupeKey: sha256({ type: "driver_arrival_threshold", rideRef: id }),
    });
    const outbox = {
      schema: "openclaw.uber.alert-outbox",
      version: 1,
      id: eventId,
      status: "pending",
      createdAt: at,
      availableAt: at,
      claimedAt: null,
      leaseUntil: null,
      claimToken: null,
      claimantDigest: null,
      attempts: 0,
      deliveredAt: null,
      lastErrorCode: null,
      event,
    };
    writePrivateJson(this.path("outbox", eventId), outbox, { exclusive: true });
    const next = { ...current, arrivalAlertEnqueuedAt: at, monitorActive: false, updatedAt: at };
    writePrivateJson(this.path("rides", id), next);
    this.ledger.append("alert.enqueued", { eventId, rideRef: id, type: event.type, dedupeKey: event.dedupeKey, pickupEtaMinutes: event.pickupEtaMinutes });
    return Object.freeze({ ride: Object.freeze(next), enqueued: true, event });
  }

  claimPendingAlert(workerId, leaseMs = 60_000) {
    return this.withOutboxLock(() => this._claimPendingAlert(workerId, leaseMs));
  }

  _claimPendingAlert(workerId, leaseMs) {
    if (typeof workerId !== "string" || workerId.length < 3 || workerId.length > 128 || /[\u0000-\u001f\u007f]/u.test(workerId)) throw governed("outbox_worker_invalid", "The Uber alert worker identity is invalid.");
    if (!Number.isInteger(leaseMs) || leaseMs < 5_000 || leaseMs > 5 * 60_000) throw governed("outbox_lease_invalid", "The Uber alert lease is invalid.");
    const now = this.date();
    const directory = path.join(this.directory, "outbox");
    const eligible = fs.readdirSync(directory).filter((name) => /^[a-f0-9-]{36}\.json$/u.test(name)).map((name) => readPrivateJson(path.join(directory, name)))
      .filter((record) => record.status === "pending" && new Date(record.availableAt) <= now || record.status === "claimed" && new Date(record.leaseUntil) <= now)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const current = eligible[0];
    if (!current) return null;
    const claimToken = randomId();
    const claimed = {
      ...current,
      status: "claimed",
      claimedAt: now.toISOString(),
      leaseUntil: new Date(now.getTime() + leaseMs).toISOString(),
      claimToken,
      claimantDigest: sha256(workerId),
      attempts: current.attempts + 1,
    };
    writePrivateJson(this.path("outbox", current.id), claimed);
    this.ledger.append("alert.claimed", { eventId: current.id, claimantDigest: claimed.claimantDigest, attempt: claimed.attempts, leaseUntil: claimed.leaseUntil });
    return Object.freeze({ event: Object.freeze(claimed.event), claimToken, leaseUntil: claimed.leaseUntil, attempt: claimed.attempts });
  }

  acknowledgeAlert(eventId, claimToken, deliveryId) {
    return this.withOutboxLock(() => this._acknowledgeAlert(eventId, claimToken, deliveryId));
  }

  _acknowledgeAlert(eventId, claimToken, deliveryId) {
    const current = this.readOutbox(eventId);
    requireClaim(current, claimToken, this.date());
    if (typeof deliveryId !== "string" || deliveryId.length < 3 || deliveryId.length > 256) throw governed("delivery_evidence_invalid", "The Uber alert delivery evidence is invalid.");
    const at = this.timestamp();
    const delivered = { ...current, status: "delivered", deliveredAt: at, leaseUntil: null, claimToken: null, lastErrorCode: null };
    writePrivateJson(this.path("outbox", eventId), delivered);
    this.ledger.append("alert.delivered", { eventId, dedupeKey: current.event.dedupeKey, deliveryIdDigest: sha256(deliveryId), attempt: current.attempts });
    return Object.freeze({ delivered: true, eventId, dedupeKey: current.event.dedupeKey, deliveredAt: at });
  }

  releaseAlert(eventId, claimToken, errorCode) {
    return this.withOutboxLock(() => this._releaseAlert(eventId, claimToken, errorCode));
  }

  _releaseAlert(eventId, claimToken, errorCode) {
    const current = this.readOutbox(eventId);
    requireClaim(current, claimToken, this.date());
    if (typeof errorCode !== "string" || !/^[a-z0-9_.-]{2,80}$/u.test(errorCode)) throw governed("delivery_error_code_invalid", "The Uber alert delivery error code is invalid.");
    const now = this.date();
    const delay = Math.min(5 * 60_000, 5_000 * (2 ** Math.min(current.attempts - 1, 6)));
    const pending = { ...current, status: "pending", availableAt: new Date(now.getTime() + delay).toISOString(), leaseUntil: null, claimToken: null, lastErrorCode: errorCode };
    writePrivateJson(this.path("outbox", eventId), pending);
    this.ledger.append("alert.released", { eventId, errorCode, attempt: current.attempts, availableAt: pending.availableAt });
    return Object.freeze({ released: true, eventId, retryAt: pending.availableAt });
  }

  readOutbox(id) {
    const value = readPrivateJson(this.path("outbox", id));
    if (value?.schema !== "openclaw.uber.alert-outbox" || value.version !== 1 || value.id !== id || !new Set(["pending", "claimed", "delivered"]).has(value.status)) throw governed("outbox_record_invalid", "The Uber alert outbox record is invalid.");
    return value;
  }

  withOutboxLock(operation) {
    const lockPath = path.join(this.directory, "outbox.lock");
    let descriptor;
    try {
      descriptor = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    } catch (error) {
      if (error?.code === "EEXIST") throw governed("outbox_busy", "The Uber alert outbox is busy; retry later.", { retryable: true });
      throw error;
    }
    try {
      fs.writeFileSync(descriptor, `${process.pid}\n`);
      fs.fsyncSync(descriptor);
      return operation();
    } finally {
      fs.closeSync(descriptor);
      const stat = fs.lstatSync(lockPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw governed("outbox_lock_invalid", "The Uber outbox lock is unsafe.");
      fs.unlinkSync(lockPath);
    }
  }

  createCancelChallenge(ride, principal) {
    if (TERMINAL_RIDE_STATUSES.has(ride.status)) throw governed("ride_terminal", "A terminal Uber ride cannot be canceled.");
    const id = randomId();
    const now = this.date();
    const record = {
      schema: "openclaw.uber.cancel-challenge",
      version: 1,
      id,
      status: "active",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
      consumedAt: null,
      challenge: randomChallenge("CANCEL"),
      principalBinding: principal.bindingDigest,
      originMessageIdDigest: principal.messageIdDigest,
      originRunIdDigest: principal.runIdDigest,
      rideRef: ride.id,
      requestDigest: sha256(ride.requestId),
      cancellationNotice: CANCELLATION_NOTICE,
    };
    writePrivateJson(this.path("cancel-challenges", id), record, { exclusive: true });
    this.ledger.append("cancel.challenge.created", { challengeId: id, rideRef: ride.id, status: ride.status, expiresAt: record.expiresAt });
    return Object.freeze(record);
  }

  requireCancelChallenge(id, principal) {
    const record = validateChallenge(readPrivateJson(this.path("cancel-challenges", id)), "cancel");
    this.requireChallengeActive(record, principal);
    const ride = this.readRide(record.rideRef, principal);
    if (record.requestDigest !== sha256(ride.requestId)) throw governed("challenge_tampered", "The immutable Uber cancellation preview failed integrity verification.");
    if (TERMINAL_RIDE_STATUSES.has(ride.status)) throw governed("ride_terminal", "A terminal Uber ride cannot be canceled.");
    return Object.freeze({ challenge: record, ride });
  }

  requireChallengeActive(record, principal) {
    if (record.status !== "active") throw governed("challenge_consumed", "This Uber confirmation challenge has already been used.");
    if (new Date(record.expiresAt) <= this.date()) throw governed("challenge_expired", "This Uber confirmation challenge has expired.");
    if (record.principalBinding !== principal.bindingDigest) throw governed("challenge_principal_mismatch", "This Uber challenge belongs to a different iMessage principal or conversation.");
    if (principal.messageBodyDigest !== sha256(record.challenge)) throw governed("confirmation_message_mismatch", `A new owner message containing exactly ${record.challenge} is required.`);
    if (principal.messageIdDigest === record.originMessageIdDigest || principal.runIdDigest === record.originRunIdDigest) throw governed("confirmation_message_not_new", "Ride and cancellation confirmation must arrive in a new owner iMessage and a new agent run.");
  }

  path(kind, id) {
    if (!UUID.test(String(id ?? ""))) throw governed("record_id_invalid", "The Uber record identifier is invalid.");
    return safeRecordPath(path.join(this.directory, kind), id);
  }

  date() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw governed("clock_invalid", "The Uber governance clock is invalid.");
    return date;
  }

  timestamp() { return this.date().toISOString(); }
}

function normalizeFare(value) {
  if (!value || typeof value !== "object") throw governed("fare_missing", "Uber did not return an upfront fare.");
  const fareId = string(value.fare_id, 8, 512, "fare_id_invalid");
  const expires = Number(value.expires_at);
  const expiresAt = new Date(expires > 10_000_000_000 ? expires : expires * 1000);
  if (!Number.isFinite(expiresAt.getTime())) throw governed("fare_expiry_invalid", "The Uber fare expiry is invalid.");
  return Object.freeze({
    fareId,
    expiresAt: expiresAt.toISOString(),
    display: string(value.display, 1, 80, "fare_display_invalid"),
    currencyCode: string(value.currency_code, 3, 3, "fare_currency_invalid").toUpperCase(),
    value: optionalNumber(value.value, 0, 1_000_000),
  });
}

function normalizeTrip(value) {
  if (!value || typeof value !== "object") return Object.freeze({ durationEstimateSeconds: null, distanceEstimate: null, distanceUnit: null });
  return Object.freeze({
    durationEstimateSeconds: optionalNumber(value.duration_estimate, 0, 7 * 24 * 60 * 60),
    distanceEstimate: optionalNumber(value.distance_estimate, 0, 100_000),
    distanceUnit: value.distance_unit === undefined ? null : string(value.distance_unit, 1, 20, "distance_unit_invalid"),
  });
}

function normalizeRideStatus(value) {
  const status = string(value, 2, 80, "ride_status_invalid");
  if (!RIDE_STATUSES.has(status)) throw governed("ride_status_invalid", "Uber returned an unknown ride status.");
  return status;
}

function validateEstimate(record) {
  if (record?.schema !== "openclaw.uber.estimate" || record.version !== 1 || !UUID.test(record.id) || record.status !== "active") throw governed("estimate_record_invalid", "The private Uber estimate record is invalid.");
  return record;
}

function validateChallenge(record, kind) {
  const schema = kind === "ride" ? "openclaw.uber.ride-challenge" : "openclaw.uber.cancel-challenge";
  if (record?.schema !== schema || record.version !== 1 || !UUID.test(record.id) || !new Set(["active", "consumed"]).has(record.status)) throw governed("challenge_record_invalid", "The private Uber challenge record is invalid.");
  return record;
}

function validateRide(record) {
  if (record?.schema !== "openclaw.uber.ride" || record.version !== 1 || !UUID.test(record.id) || typeof record.requestId !== "string") throw governed("ride_record_invalid", "The private Uber ride record is invalid.");
  return record;
}

function safeEvidence(evidence) {
  const output = {};
  for (const key of ["rideRef", "status", "apiStatus"]) if (evidence[key] !== undefined) output[key] = evidence[key];
  return output;
}

function requireClaim(record, claimToken, now) {
  if (record.status !== "claimed" || typeof claimToken !== "string" || record.claimToken !== claimToken || new Date(record.leaseUntil) <= now) throw governed("outbox_claim_invalid", "The Uber alert delivery claim is invalid or expired.");
}

function string(value, min, max, code) {
  if (typeof value !== "string" || value.length < min || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw governed(code, "An Uber API field is invalid.");
  return value;
}

function optionalNumber(value, min, max) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw governed("uber_number_invalid", "An Uber API numeric field is invalid.");
  return number;
}
