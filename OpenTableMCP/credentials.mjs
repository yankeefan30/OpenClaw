import { ALL_CAPABILITIES } from "./constants.mjs";
import { exactObject } from "./canonical.mjs";
import { governed } from "./errors.mjs";

const DIGEST = /^[a-f0-9]{64}$/u;
const BASE64_32 = /^[A-Za-z0-9+/]{43}=$/u;
const HOSTS = Object.freeze({
  production: Object.freeze({ api: "platform.opentable.com", oauth: "oauth.opentable.com" }),
  sandbox: Object.freeze({ api: "platform.otqa.com", oauth: "oauth-pp.opentable.com" }),
});

export function parseCredentialBundle(buffer, now = new Date()) {
  let parsed;
  let text;
  try {
    text = buffer.toString("utf8");
    parsed = JSON.parse(text);
  } catch {
    throw governed("credential_bundle_invalid", "The OpenTable Keychain item is not a valid reviewed credential bundle.");
  } finally {
    text = undefined;
  }

  exactObject(parsed, [
    "schema", "version", "enabled", "environment", "apiFamily", "clientId", "clientSecret",
    "apiBaseUrl", "oauthBaseUrl", "invocationHmacKey", "diner", "approval",
  ], "credential_bundle_fields_invalid");
  if (parsed.schema !== "openclaw.opentable.partner-credentials" || parsed.version !== 1) {
    throw governed("credential_bundle_schema_invalid", "The OpenTable credential bundle schema is not supported.");
  }
  if (parsed.enabled !== true) throw governed("opentable_disabled", "OpenTable actions are disabled in the reviewed Keychain bundle.");
  if (!Object.hasOwn(HOSTS, parsed.environment)) throw governed("environment_invalid", "The OpenTable environment is not approved.");
  if (parsed.apiFamily !== "consumer-v2") {
    throw governed("api_family_not_approved", "Rico via iMessage requires an approved Consumer API v2 contract; Voice AI and in-house paths are not interchangeable.");
  }

  const apiBaseUrl = validateBaseUrl(parsed.apiBaseUrl, HOSTS[parsed.environment].api, "api_base_url_invalid");
  const oauthBaseUrl = validateBaseUrl(parsed.oauthBaseUrl, HOSTS[parsed.environment].oauth, "oauth_base_url_invalid");
  requireSecret(parsed.clientId, "client_id_missing");
  requireSecret(parsed.clientSecret, "client_secret_missing");
  if (!BASE64_32.test(parsed.invocationHmacKey)) throw governed("invocation_key_invalid", "The iMessage invocation proof key must be a 32-byte base64 value.");
  const diner = validateDiner(parsed.diner);
  const approval = validateApproval(parsed.approval, now);

  return Object.freeze({
    schema: parsed.schema,
    version: parsed.version,
    enabled: true,
    environment: parsed.environment,
    apiFamily: parsed.apiFamily,
    clientId: parsed.clientId,
    clientSecret: parsed.clientSecret,
    apiBaseUrl,
    oauthBaseUrl,
    invocationHmacKey: parsed.invocationHmacKey,
    diner,
    approval,
  });
}

export function scrubCredentialBundle(bundle) {
  if (!bundle || typeof bundle !== "object") return;
  for (const key of ["clientId", "clientSecret", "invocationHmacKey"]) {
    try { bundle[key] = ""; } catch { /* frozen reviewed objects cannot be overwritten */ }
  }
}

function validateApproval(value, now) {
  exactObject(value, [
    "partnerApproved", "appReviewed", "agreementReference", "contractDocumentSha256",
    "approvedCapabilities", "approvedInterface", "approvedAt", "expiresAt",
  ], "approval_fields_invalid");
  if (value.partnerApproved !== true || value.appReviewed !== true) {
    throw governed("partner_approval_missing", "OpenTable partner approval and app review are required.");
  }
  if (value.approvedInterface !== "consumer-visual-imessage") {
    throw governed("interface_not_approved", "The partner contract does not prove approval for Rico's visual iMessage booking flow.");
  }
  if (typeof value.agreementReference !== "string" || value.agreementReference.trim().length < 6 || value.agreementReference.length > 128) {
    throw governed("agreement_reference_invalid", "The partner agreement reference is missing or invalid.");
  }
  if (!DIGEST.test(String(value.contractDocumentSha256 ?? ""))) {
    throw governed("contract_proof_invalid", "The reviewed OpenTable contract digest is missing or invalid.");
  }
  if (!Array.isArray(value.approvedCapabilities) || value.approvedCapabilities.length === 0) {
    throw governed("capability_proof_missing", "No OpenTable API capability has been approved.");
  }
  const capabilities = [...new Set(value.approvedCapabilities)];
  if (capabilities.length !== value.approvedCapabilities.length || capabilities.some((item) => !ALL_CAPABILITIES.includes(item))) {
    throw governed("capability_proof_invalid", "The OpenTable capability proof is invalid.");
  }
  const approvedAt = new Date(value.approvedAt);
  const expiresAt = new Date(value.expiresAt);
  const clock = now instanceof Date ? now : new Date(now);
  if (![approvedAt, expiresAt, clock].every((item) => Number.isFinite(item.getTime())) || approvedAt > clock || expiresAt <= clock) {
    throw governed("partner_approval_expired", "The OpenTable partner capability proof is not currently valid.");
  }
  return Object.freeze({
    partnerApproved: true,
    appReviewed: true,
    agreementReference: value.agreementReference.trim(),
    contractDocumentSha256: value.contractDocumentSha256,
    approvedCapabilities: Object.freeze(capabilities.sort()),
    approvedInterface: value.approvedInterface,
    approvedAt: approvedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
}

function validateDiner(value) {
  exactObject(value, ["firstName", "lastName", "email", "phone"], "diner_fields_invalid");
  const firstName = clean(value.firstName, 1, 80, "diner_first_name_invalid");
  const lastName = clean(value.lastName, 1, 80, "diner_last_name_invalid");
  const email = clean(value.email, 3, 254, "diner_email_invalid");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw governed("diner_email_invalid", "The Keychain diner email is invalid.");
  exactObject(value.phone, ["countryCode", "number", "type"], "diner_phone_fields_invalid");
  const countryCode = clean(value.phone.countryCode, 2, 3, "diner_phone_country_invalid").toUpperCase();
  const number = clean(value.phone.number, 7, 20, "diner_phone_invalid");
  if (!/^\+?[0-9]{7,19}$/u.test(number)) throw governed("diner_phone_invalid", "The Keychain diner phone number is invalid.");
  if (value.phone.type !== "Mobile") throw governed("diner_phone_type_invalid", "The Keychain diner phone type must be Mobile.");
  return Object.freeze({ firstName, lastName, email, phone: Object.freeze({ countryCode, number, type: "Mobile" }) });
}

function validateBaseUrl(value, expectedHost, code) {
  let url;
  try { url = new URL(value); } catch { throw governed(code, "The reviewed OpenTable endpoint is invalid."); }
  if (url.protocol !== "https:" || url.hostname !== expectedHost || url.port || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw governed(code, "The reviewed OpenTable endpoint does not match the official environment host.");
  }
  return `https://${expectedHost}`;
}

function requireSecret(value, code) {
  if (typeof value !== "string" || value.length < 8 || value.length > 4096) throw governed(code, "A required OpenTable credential is missing.");
}

function clean(value, min, max, code) {
  if (typeof value !== "string") throw governed(code, "A required Keychain profile field is invalid.");
  const result = value.trim();
  if (result.length < min || result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) throw governed(code, "A required Keychain profile field is invalid.");
  return result;
}
