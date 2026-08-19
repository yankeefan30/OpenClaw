import assert from "node:assert/strict";
import test from "node:test";
import {
  accessTokenFromEnv,
  bundleFromEnv,
  bundleFromOAuthTokenResponse,
  isAccessTokenFresh,
  parseCredentialBundle,
} from "../credentials.mjs";

function validBundle(overrides = {}) {
  return {
    schema: "rico.pressmaster.oauth-bundle",
    version: 1,
    issuer: "https://app.pressmaster.ai/oauth/mcp",
    resource: "https://app.pressmaster.ai/mcp",
    clientId: "public-client-id-value",
    tokenEndpointAuthMethod: "none",
    accessToken: "access-token-value-1234",
    refreshToken: "refresh-token-value-1234",
    tokenType: "Bearer",
    scope: "openid offline_access mcp",
    expiresAt: "2027-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("parses a pinned official OAuth bundle", () => {
  const bundle = parseCredentialBundle(Buffer.from(JSON.stringify(validBundle()), "utf8"));
  assert.equal(bundle.resource, "https://app.pressmaster.ai/mcp");
  assert.equal(bundle.tokenEndpointAuthMethod, "none");
});

test("rejects extra fields, wrong hosts, and missing mcp scope", () => {
  assert.throws(
    () => parseCredentialBundle(Buffer.from(JSON.stringify({ ...validBundle(), extra: true }), "utf8")),
    { code: "credential_bundle_fields_invalid" },
  );
  assert.throws(
    () => parseCredentialBundle(Buffer.from(JSON.stringify(validBundle({ issuer: "https://evil.example/oauth" })), "utf8")),
    { code: "credential_host_invalid" },
  );
  assert.throws(
    () => parseCredentialBundle(Buffer.from(JSON.stringify(validBundle({ scope: "openid" })), "utf8")),
    { code: "credential_bundle_invalid" },
  );
});

test("env bearer is accepted without printing it", () => {
  const token = "env-access-token-abcdef";
  assert.equal(accessTokenFromEnv({ PRESSMASTER_ACCESS_TOKEN: token }), token);
  const bundle = bundleFromEnv({ PRESSMASTER_ACCESS_TOKEN: token, PRESSMASTER_CLIENT_ID: "env-client-id-1" });
  assert.equal(bundle.accessToken, token);
  assert.equal(bundle.issuer, "https://app.pressmaster.ai/oauth/mcp");
});

test("token freshness uses expiry skew", () => {
  const now = new Date("2026-08-19T13:00:00.000Z");
  const fresh = bundleFromOAuthTokenResponse({
    clientId: "public-client-id-value",
    accessToken: "access-token-value-1234",
    expiresIn: 3600,
    now,
  });
  assert.equal(isAccessTokenFresh(fresh, now), true);
  assert.equal(isAccessTokenFresh({ ...fresh, expiresAt: "2026-08-19T13:00:30.000Z" }, now, 60_000), false);
});
