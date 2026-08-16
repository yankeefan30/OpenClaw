import assert from "node:assert/strict";
import test from "node:test";
import { OfficialOpenTableClient } from "../official-client.mjs";
import { BufferCredentialProvider, emptyResponse, FIXED_NOW, jsonResponse } from "./helpers.mjs";

test("official client uses OAuth, approved endpoints, no payment results, and stable request IDs", async () => {
  const calls = [];
  const responses = [
    jsonResponse({ access_token: "access-token-long-enough" }),
    jsonResponse({ times_available: [] }),
    jsonResponse({ reservation_token: "reservation-token-long-enough", expires_at: "2026-08-15T16:04:00.000Z" }),
    emptyResponse(),
  ];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    return responses.shift();
  };
  const client = new OfficialOpenTableClient({ credentialProvider: new BufferCredentialProvider(), fetchFn, now: () => FIXED_NOW });
  await client.withSession(async (session) => {
    await session.availability({ rid: 123, startDateTime: "2026-08-16T19:00", forwardMinutes: 120, backwardMinutes: 60, partySize: 2, reservationAttribute: "default" });
    await session.createSlotLock({ rid: 123, dateTime: "2026-08-16T19:00", partySize: 2, reservationAttribute: "default", diningAreaId: null, environment: null }, "11111111-1111-4111-8111-111111111111");
    await session.cancelReservation({ rid: 123, confirmationNumber: "456" }, "22222222-2222-4222-8222-222222222222");
  });
  assert.equal(calls[0].url, "https://oauth.opentable.com/api/v2/oauth/token?grant_type=client_credentials");
  assert.equal(calls[0].options.method, "GET");
  assert.match(calls[0].options.headers.Authorization, /^Basic /u);
  assert.ok(!calls[0].url.includes("reviewed-client-secret"));
  const availability = new URL(calls[1].url);
  assert.equal(availability.origin, "https://platform.opentable.com");
  assert.equal(availability.pathname, "/v2/availability/123");
  assert.equal(availability.searchParams.get("include_credit_card_results"), "false");
  assert.equal(availability.searchParams.get("include_experiences"), "false");
  assert.equal(calls[2].options.headers["X-Request-Id"], "11111111-1111-4111-8111-111111111111");
  assert.equal(calls[3].options.method, "PUT");
  assert.deepEqual(JSON.parse(calls[3].options.body), { status: "CancelledWeb" });
});

test("official API errors disclose only status and request ID, never body", async () => {
  const secretBody = "sensitive upstream detail";
  const responses = [
    jsonResponse({ access_token: "access-token-long-enough" }),
    jsonResponse({ errors: [{ message: secretBody }] }, { status: 409, headers: { "ot-requestid": "request-123" } }),
  ];
  const client = new OfficialOpenTableClient({ credentialProvider: new BufferCredentialProvider(), fetchFn: async () => responses.shift(), now: () => FIXED_NOW });
  await assert.rejects(client.withSession((session) => session.availability({ rid: 1, startDateTime: "2026-08-16T19:00", forwardMinutes: 1, backwardMinutes: 1, partySize: 2, reservationAttribute: "default" })), (error) => {
    assert.equal(error.code, "opentable_api_error");
    assert.deepEqual(error.details, { status: 409, requestId: "request-123" });
    assert.ok(!error.message.includes(secretBody));
    return true;
  });
});
