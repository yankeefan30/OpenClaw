import { API_ORIGINS, OAUTH_ORIGIN } from "./constants.mjs";
import { exactObject } from "./canonical.mjs";
import { governed } from "./errors.mjs";

const BASE64_32 = /^[A-Za-z0-9+/]{43}=$/u;
const ALIASES = ["personal", "business"];
const BOOKING_SCOPES = new Set(["request", "ride_request.ride_booking"]);
const ESTIMATE_SCOPES = new Set(["request", "ride_request.estimate", "ride_request.ride_booking"]);
const PAYMENT_SCOPES = new Set(["request", "ride_request.user_payment_methods"]);

export function parseCredentialBundle(buffer, now = new Date()) {
  let parsed;
  try { parsed = JSON.parse(buffer.toString("utf8")); } catch {
    throw governed("credential_bundle_invalid", "The Uber Keychain item is not a valid OAuth bundle.");
  }
  exactObject(parsed, [
    "schema", "version", "enabled", "environment", "apiBaseUrl", "oauthBaseUrl",
    "clientId", "clientSecret", "accessToken", "refreshToken", "tokenType",
    "expiresAt", "scopes", "invocationHmacKey", "locationHmacKey", "paymentAliases", "approval",
  ], "credential_bundle_fields_invalid");
  if (parsed.schema !== "openclaw.uber.oauth-bundle" || parsed.version !== 1) {
    throw governed("credential_bundle_schema_invalid", "The Uber Keychain OAuth bundle schema is unsupported.");
  }
  if (parsed.enabled !== true) throw governed("uber_disabled", "Uber ride actions are disabled in the Keychain bundle.");
  if (!Object.hasOwn(API_ORIGINS, parsed.environment)) throw governed("environment_invalid", "The Uber API environment is invalid.");
  const apiBaseUrl = exactOrigin(parsed.apiBaseUrl, API_ORIGINS[parsed.environment], "api_origin_invalid");
  const oauthBaseUrl = exactOrigin(parsed.oauthBaseUrl, OAUTH_ORIGIN, "oauth_origin_invalid");
  requireSecret(parsed.clientId, "oauth_client_id_missing");
  requireSecret(parsed.clientSecret, "oauth_client_secret_missing");
  requireSecret(parsed.accessToken, "oauth_access_token_missing");
  requireSecret(parsed.refreshToken, "oauth_refresh_token_missing");
  if (parsed.tokenType !== "Bearer") throw governed("oauth_token_type_invalid", "The Uber OAuth token type must be Bearer.");
  const expiresAt = new Date(parsed.expiresAt);
  if (!Number.isFinite(expiresAt.getTime())) throw governed("oauth_expiry_invalid", "The Uber OAuth expiry is invalid.");
  if (!Array.isArray(parsed.scopes) || parsed.scopes.length === 0 || parsed.scopes.some((scope) => typeof scope !== "string" || scope.length > 100)) {
    throw governed("oauth_scopes_invalid", "The Uber OAuth scope set is invalid.");
  }
  const scopes = [...new Set(parsed.scopes)].sort();
  if (!scopes.some((scope) => BOOKING_SCOPES.has(scope))) {
    throw governed("privileged_request_scope_missing", "The privileged Uber ride-booking/request scope is missing.");
  }
  if (!scopes.some((scope) => ESTIMATE_SCOPES.has(scope))) {
    throw governed("estimate_scope_missing", "The Uber estimate scope is missing.");
  }
  if (!scopes.some((scope) => PAYMENT_SCOPES.has(scope))) {
    throw governed("payment_methods_scope_missing", "The Uber payment-method read scope is missing, so payment aliases cannot be revalidated.");
  }
  if (!BASE64_32.test(String(parsed.invocationHmacKey ?? ""))) {
    throw governed("invocation_key_invalid", "The Uber invocation-proof key is invalid.");
  }
  if (!BASE64_32.test(String(parsed.locationHmacKey ?? "")) || parsed.locationHmacKey === parsed.invocationHmacKey) {
    throw governed("location_key_invalid", "A separate 32-byte Uber location-reference key is required.");
  }
  exactObject(parsed.paymentAliases, ALIASES, "payment_aliases_invalid");
  const paymentAliases = {};
  for (const alias of ALIASES) {
    const identifier = parsed.paymentAliases[alias];
    if (typeof identifier !== "string" || identifier.length < 8 || identifier.length > 256 || /\s/u.test(identifier)) {
      throw governed("payment_alias_invalid", `The ${alias} Uber payment alias is not configured.`);
    }
    paymentAliases[alias] = identifier;
  }
  if (paymentAliases.personal === paymentAliases.business) {
    throw governed("payment_alias_collision", "Personal and business Uber payment aliases must resolve to different methods.");
  }
  const approval = parseApproval(parsed.approval, now);
  return Object.freeze({
    schema: parsed.schema,
    version: 1,
    enabled: true,
    environment: parsed.environment,
    apiBaseUrl,
    oauthBaseUrl,
    clientId: parsed.clientId,
    clientSecret: parsed.clientSecret,
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    tokenType: "Bearer",
    expiresAt: expiresAt.toISOString(),
    scopes: Object.freeze(scopes),
    invocationHmacKey: parsed.invocationHmacKey,
    locationHmacKey: parsed.locationHmacKey,
    paymentAliases: Object.freeze(paymentAliases),
    approval,
  });
}

export function credentialBundleForStorage(bundle, updates) {
  return {
    schema: bundle.schema,
    version: bundle.version,
    enabled: bundle.enabled,
    environment: bundle.environment,
    apiBaseUrl: bundle.apiBaseUrl,
    oauthBaseUrl: bundle.oauthBaseUrl,
    clientId: bundle.clientId,
    clientSecret: bundle.clientSecret,
    accessToken: updates.accessToken,
    refreshToken: updates.refreshToken,
    tokenType: "Bearer",
    expiresAt: updates.expiresAt,
    scopes: [...updates.scopes],
    invocationHmacKey: bundle.invocationHmacKey,
    locationHmacKey: bundle.locationHmacKey,
    paymentAliases: { ...bundle.paymentAliases },
    approval: { ...bundle.approval },
  };
}

export function hasBookingScope(bundle) {
  return bundle.scopes.some((scope) => BOOKING_SCOPES.has(scope));
}

function parseApproval(value, now) {
  exactObject(value, ["privilegedRequestApproved", "ownerAuthorized", "approvedAt", "expiresAt", "reference"], "approval_invalid");
  if (value.privilegedRequestApproved !== true || value.ownerAuthorized !== true) {
    throw governed("privileged_request_not_approved", "Uber privileged ride requests are not approved for this owner account.");
  }
  const approvedAt = new Date(value.approvedAt);
  const expiresAt = new Date(value.expiresAt);
  const clock = now instanceof Date ? now : new Date(now);
  if (![approvedAt, expiresAt, clock].every((item) => Number.isFinite(item.getTime())) || approvedAt > clock || expiresAt <= clock) {
    throw governed("uber_approval_expired", "The reviewed Uber authorization is not currently valid.");
  }
  if (typeof value.reference !== "string" || value.reference.trim().length < 6 || value.reference.length > 128) {
    throw governed("approval_reference_invalid", "The Uber privileged-scope approval reference is missing.");
  }
  return Object.freeze({
    privilegedRequestApproved: true,
    ownerAuthorized: true,
    approvedAt: approvedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    reference: value.reference.trim(),
  });
}

function exactOrigin(value, expected, code) {
  let url;
  try { url = new URL(value); } catch { throw governed(code, "A reviewed Uber endpoint is invalid."); }
  if (url.origin !== expected || url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw governed(code, "A reviewed Uber endpoint does not match the official origin.");
  }
  return expected;
}

function requireSecret(value, code) {
  if (typeof value !== "string" || value.length < 8 || value.length > 8192) throw governed(code, "A required Uber OAuth credential is missing.");
}
