import {
  CREDENTIAL_SCHEMA,
  CREDENTIAL_VERSION,
  PRESSMASTER_ISSUER,
  PRESSMASTER_RESOURCE,
} from "./constants.mjs";
import { fail } from "./errors.mjs";

const BUNDLE_KEYS = Object.freeze([
  "schema",
  "version",
  "issuer",
  "resource",
  "clientId",
  "tokenEndpointAuthMethod",
  "accessToken",
  "refreshToken",
  "tokenType",
  "scope",
  "expiresAt",
]);

export function parseCredentialBundle(buffer, now = new Date()) {
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw fail("credential_bundle_invalid", "The Pressmaster Keychain item is not a valid OAuth bundle.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw fail("credential_bundle_invalid", "The Pressmaster Keychain item is not a valid OAuth bundle.");
  }
  const extra = Object.keys(parsed).filter((key) => !BUNDLE_KEYS.includes(key));
  if (extra.length) throw fail("credential_bundle_fields_invalid", "The Pressmaster OAuth bundle has unsupported fields.");
  for (const key of BUNDLE_KEYS) {
    if (!Object.hasOwn(parsed, key)) throw fail("credential_bundle_fields_invalid", "The Pressmaster OAuth bundle is missing required fields.");
  }
  if (parsed.schema !== CREDENTIAL_SCHEMA || parsed.version !== CREDENTIAL_VERSION) {
    throw fail("credential_bundle_schema_invalid", "The Pressmaster OAuth bundle schema is not supported.");
  }
  if (parsed.issuer !== PRESSMASTER_ISSUER || parsed.resource !== PRESSMASTER_RESOURCE) {
    throw fail("credential_host_invalid", "The Pressmaster OAuth bundle does not pin the official MCP issuer and resource.");
  }
  if (parsed.tokenEndpointAuthMethod !== "none") {
    throw fail("credential_bundle_invalid", "Only public PKCE clients (token_endpoint_auth_method=none) are accepted.");
  }
  if (parsed.tokenType !== "Bearer") {
    throw fail("credential_bundle_invalid", "The Pressmaster token type must be Bearer.");
  }
  requireSecret(parsed.clientId, "client_id");
  requireSecret(parsed.accessToken, "access_token");
  if (parsed.refreshToken != null && parsed.refreshToken !== "") requireSecret(parsed.refreshToken, "refresh_token");
  if (typeof parsed.scope !== "string" || !parsed.scope.split(/\s+/u).includes("mcp")) {
    throw fail("credential_bundle_invalid", "The Pressmaster OAuth bundle must include the mcp scope.");
  }
  if (parsed.expiresAt != null && parsed.expiresAt !== "") {
    const expires = Date.parse(parsed.expiresAt);
    if (!Number.isFinite(expires)) throw fail("credential_bundle_invalid", "The Pressmaster token expiry is invalid.");
  }
  void now;
  return Object.freeze({
    schema: parsed.schema,
    version: parsed.version,
    issuer: parsed.issuer,
    resource: parsed.resource,
    clientId: parsed.clientId,
    tokenEndpointAuthMethod: parsed.tokenEndpointAuthMethod,
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken || "",
    tokenType: parsed.tokenType,
    scope: parsed.scope,
    expiresAt: parsed.expiresAt || "",
  });
}

export function bundleFromOAuthTokenResponse({
  clientId,
  accessToken,
  refreshToken = "",
  tokenType = "Bearer",
  scope = "mcp",
  expiresIn,
  now = new Date(),
}) {
  requireSecret(clientId, "client_id");
  requireSecret(accessToken, "access_token");
  let expiresAt = "";
  if (expiresIn != null && expiresIn !== "") {
    const seconds = Number(expiresIn);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw fail("oauth_token_invalid", "Pressmaster returned an invalid expires_in.");
    }
    expiresAt = new Date(now.getTime() + seconds * 1000).toISOString();
  }
  return Object.freeze({
    schema: CREDENTIAL_SCHEMA,
    version: CREDENTIAL_VERSION,
    issuer: PRESSMASTER_ISSUER,
    resource: PRESSMASTER_RESOURCE,
    clientId,
    tokenEndpointAuthMethod: "none",
    accessToken,
    refreshToken: refreshToken || "",
    tokenType: tokenType || "Bearer",
    scope: typeof scope === "string" && scope.trim() ? scope : "mcp",
    expiresAt,
  });
}

export function accessTokenFromEnv(env = process.env) {
  const token = typeof env.PRESSMASTER_ACCESS_TOKEN === "string" ? env.PRESSMASTER_ACCESS_TOKEN.trim() : "";
  if (!token) return null;
  if (token.length < 16 || token.length > 16_384) {
    throw fail("credential_bundle_invalid", "PRESSMASTER_ACCESS_TOKEN is present but not a usable bearer.");
  }
  return token;
}

export function bundleFromEnv(env = process.env, now = new Date()) {
  const raw = typeof env.PRESSMASTER_OAUTH_BUNDLE === "string" ? env.PRESSMASTER_OAUTH_BUNDLE.trim() : "";
  if (raw) return parseCredentialBundle(Buffer.from(raw, "utf8"), now);
  const accessToken = accessTokenFromEnv(env);
  if (!accessToken) return null;
  return bundleFromOAuthTokenResponse({
    clientId: env.PRESSMASTER_CLIENT_ID || "env-bearer",
    accessToken,
    refreshToken: typeof env.PRESSMASTER_REFRESH_TOKEN === "string" ? env.PRESSMASTER_REFRESH_TOKEN : "",
    now,
  });
}

export function isAccessTokenFresh(bundle, now = new Date(), skewMs = 60_000) {
  if (!bundle?.expiresAt) return true;
  const expires = Date.parse(bundle.expiresAt);
  if (!Number.isFinite(expires)) return false;
  return expires - skewMs > now.getTime();
}

function requireSecret(value, label) {
  if (typeof value !== "string" || value.trim().length < 8 || value.length > 16_384) {
    throw fail("credential_bundle_invalid", `The Pressmaster OAuth bundle ${label} is missing or invalid.`);
  }
}
