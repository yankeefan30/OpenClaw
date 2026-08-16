import { exactObject } from "./canonical.mjs";
import { governed } from "./errors.mjs";

const ID = /^[A-Za-z0-9_-]{8,256}$/u;
const UUID = /^[a-f0-9-]{36}$/u;
const LOCATION_REF = /^location_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/u;
const CANDIDATE_REF = /^candidate_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/u;
const PAYMENT_ALIASES = new Set(["personal", "business"]);

export function validateAddressSearchInput(value) {
  exactObject(value, ["query"], "address_search_input_invalid");
  return Object.freeze({ query: clean(value.query, 5, 300, "address_query_invalid") });
}

export function validateLocationResolveInput(value) {
  exactObject(value, ["candidateRef"], "location_resolve_input_invalid");
  if (!CANDIDATE_REF.test(String(value.candidateRef ?? ""))) throw governed("candidate_ref_invalid", "The private Uber candidate reference is invalid.");
  return Object.freeze({ candidateRef: value.candidateRef });
}

export function validateEstimateInput(value) {
  exactObject(value, ["pickupLocationRef", "dropoffLocationRef", "productId", "seatCount"], "estimate_input_invalid");
  if (!LOCATION_REF.test(String(value.pickupLocationRef ?? "")) || !LOCATION_REF.test(String(value.dropoffLocationRef ?? ""))) {
    throw governed("location_ref_invalid", "Pickup and drop-off must use server-resolved private location references.");
  }
  if (value.pickupLocationRef === value.dropoffLocationRef) throw governed("route_invalid", "Pickup and drop-off must be different locations.");
  const productId = value.productId === null ? null : cleanId(value.productId, "product_id_invalid");
  const seatCount = integer(value.seatCount, 1, 2, "seat_count_invalid");
  return Object.freeze({ pickupLocationRef: value.pickupLocationRef, dropoffLocationRef: value.dropoffLocationRef, productId, seatCount });
}

export function validateChallengeInput(value, now = new Date()) {
  exactObject(value, ["estimateRef", "paymentAlias", "scheduledFor", "expenseCode", "expenseMemo"], "challenge_input_invalid");
  if (!UUID.test(String(value.estimateRef ?? ""))) throw governed("estimate_ref_invalid", "The reviewed Uber estimate reference is invalid.");
  if (!PAYMENT_ALIASES.has(value.paymentAlias)) throw governed("payment_alias_invalid", "Choose either the personal or business Uber payment alias.");
  const scheduledFor = new Date(value.scheduledFor);
  const clock = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(scheduledFor.getTime())) throw governed("scheduled_time_invalid", "The requested Uber dispatch time is invalid.");
  if (scheduledFor.getTime() < clock.getTime() - 30_000) throw governed("scheduled_time_elapsed", "The requested Uber dispatch time has already passed.");
  if (scheduledFor.getTime() > clock.getTime() + 90_000) {
    throw governed("future_reservation_unsupported", "The official Uber Riders API v1.2 request contract is on-demand. A future ride needs a fresh estimate and confirmation near the desired dispatch time.");
  }
  const expenseCode = optionalClean(value.expenseCode, 80, "expense_code_invalid");
  const expenseMemo = optionalClean(value.expenseMemo, 256, "expense_memo_invalid");
  if (value.paymentAlias === "business" && expenseMemo === null) {
    throw governed("business_expense_memo_required", "A business ride requires an expense memo.");
  }
  if (value.paymentAlias === "personal" && (expenseCode !== null || expenseMemo !== null)) {
    throw governed("personal_expense_fields_blocked", "Business expense fields cannot be attached to the personal payment alias.");
  }
  return Object.freeze({ estimateRef: value.estimateRef, paymentAlias: value.paymentAlias, scheduledFor: scheduledFor.toISOString(), expenseCode, expenseMemo });
}

export function validateConfirmationInput(value) {
  exactObject(value, ["challengeId"], "confirmation_input_invalid");
  if (!UUID.test(String(value.challengeId ?? ""))) throw governed("challenge_id_invalid", "The Uber confirmation challenge identifier is invalid.");
  return Object.freeze({ challengeId: value.challengeId });
}

export function validateRideRef(value) {
  if (!UUID.test(String(value ?? ""))) throw governed("ride_ref_invalid", "The local Uber ride reference is invalid.");
  return value;
}

export function validateCancelConfirmation(value) {
  exactObject(value, ["challengeId"], "cancel_confirmation_invalid");
  return validateConfirmationInput(value);
}

export function cleanId(value, code) {
  const result = clean(value, 8, 256, code);
  if (!ID.test(result)) throw governed(code, "An Uber identifier is invalid.");
  return result;
}

function clean(value, min, max, code) {
  if (typeof value !== "string") throw governed(code, "A required Uber field is invalid.");
  const result = value.trim();
  if (result.length < min || result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) throw governed(code, "A required Uber field is invalid.");
  return result;
}

function optionalClean(value, max, code) {
  if (value === null) return null;
  return clean(value, 1, max, code);
}

function integer(value, min, max, code) {
  if (!Number.isInteger(value) || value < min || value > max) throw governed(code, "An Uber numeric field is invalid.");
  return value;
}
