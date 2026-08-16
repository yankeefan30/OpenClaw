import assert from "node:assert/strict";
import test from "node:test";
import { OfficialUberClient } from "../official-client.mjs";
import { NOW, validBundle } from "./helpers.mjs";

test("official client sends ride only to sandbox v1.2 and resolves payment alias in memory", async () => {
  const calls = [];
  const bundle = validBundle();
  const client = clientFor(bundle, async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/payment-methods")) return jsonResponse({ payment_methods: [
      { payment_method_id: "payment-personal-opaque", type: "visa" },
      { payment_method_id: "payment-business-opaque", type: "business_account" },
    ] });
    return jsonResponse({ request_id: "official-request-id", status: "processing" }, 202);
  });
  const result = await client.withSession((session) => session.requestRide({
    productId: "product-uber-black",
    fareId: "fare-upfront-opaque",
    pickup: exactLocation("1 Main Street", 40.75, -73.99),
    dropoff: exactLocation("2 Broadway", 40.71, -74.01),
    seatCount: 1,
    paymentAlias: "business",
    expenseCode: "CLIENT",
    expenseMemo: "Client travel",
  }));
  assert.equal(result.request_id, "official-request-id");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://sandbox-api.uber.com/v1.2/payment-methods");
  assert.equal(calls[1].url, "https://sandbox-api.uber.com/v1.2/requests");
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.payment_method_id, "payment-business-opaque");
  assert.equal(calls[1].options.headers.Authorization, "Bearer access-token-value");
});

test("status never returns OAuth secrets or raw payment identifiers", async () => {
  const bundle = validBundle();
  const client = clientFor(bundle, async () => { throw new Error("network must not be used"); });
  const status = await client.status();
  const text = JSON.stringify(status);
  assert.equal(status.enabled, true);
  for (const secret of [bundle.accessToken, bundle.refreshToken, bundle.clientSecret, bundle.paymentAliases.personal, bundle.paymentAliases.business]) {
    assert.equal(text.includes(secret), false);
  }
});

test("stale payment alias fails before ride POST", async () => {
  const calls = [];
  const client = clientFor(validBundle(), async (url) => {
    calls.push(url);
    return jsonResponse({ payment_methods: [{ payment_method_id: "payment-personal-opaque", type: "visa" }] });
  });
  await assert.rejects(client.withSession((session) => session.requestRide({
    productId: "product-uber-black", fareId: "fare-upfront-opaque",
    pickup: exactLocation("1 Main Street", 40.75, -73.99), dropoff: exactLocation("2 Broadway", 40.71, -74.01),
    seatCount: 1, paymentAlias: "business", expenseCode: null, expenseMemo: "Business",
  })), { code: "payment_alias_stale" });
  assert.deepEqual(calls, ["https://sandbox-api.uber.com/v1.2/payment-methods"]);
});

test("indeterminate mutation network failure is non-retryable outcome-unknown", async () => {
  let calls = 0;
  const client = clientFor(validBundle(), async () => { calls += 1; throw new TypeError("network"); });
  await assert.rejects(client.withSession((session) => session.cancelRide("official-request-id")), { code: "uber_mutation_outcome_unknown", retryable: false });
  assert.equal(calls, 1);
});

test("mutation 5xx is quarantined as outcome-unknown", async () => {
  const client = clientFor(validBundle(), async () => jsonResponse({ code: "internal_error" }, 503));
  await assert.rejects(client.withSession((session) => session.cancelRide("official-request-id")), { code: "uber_mutation_outcome_unknown", retryable: false });
});

test("expired access token rotation is durably handed directly to Keychain provider", async () => {
  const bundle = validBundle();
  bundle.expiresAt = new Date(NOW.getTime() - 60_000).toISOString();
  const calls = [];
  const client = clientFor(bundle, async (url, options) => {
    calls.push({ url, options });
    if (url === "https://auth.uber.com/oauth/v2/token") return jsonResponse({ access_token: "fresh-access-token", token_type: "Bearer", expires_in: 3600 });
    return jsonResponse({ products: [] });
  });
  await client.withSession((session) => session.products(exactLocation("1 Main Street", 40.75, -73.99)));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://auth.uber.com/oauth/v2/token");
  assert.equal(calls[1].options.headers.Authorization, "Bearer fresh-access-token");
  assert.equal(client.testProvider.writes.length, 1);
  const persisted = JSON.parse(client.testProvider.writes[0].toString("utf8"));
  assert.equal(persisted.accessToken, "fresh-access-token");
});

function clientFor(bundle, fetchFn) {
  const bytes = Buffer.from(JSON.stringify(bundle));
  const provider = {
    writes: [],
    status: async () => ({ available: true, service: "openclaw-uber", account: "alan" }),
    withSecret: async (operation) => operation(Buffer.from(bytes)),
    replaceSecret: async (value) => { provider.writes.push(Buffer.from(value)); },
  };
  const rateLimiter = { acquire() { return { remaining: 10 }; } };
  const client = new OfficialUberClient({ credentialProvider: provider, fetchFn, now: () => NOW, timeoutMs: 500, rateLimiter });
  client.testProvider = provider;
  return client;
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function exactLocation(formattedAddress, latitude, longitude) { return { formattedAddress, latitude, longitude }; }
