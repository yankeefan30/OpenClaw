# Governed Uber MCP

Local stdio MCP server for the official Uber Riders API v1.2. It does **not** scrape Uber, drive the consumer app, export browser cookies, or use a signed-in browser session.

## What is implemented

- Nine model-visible tools: readiness; approved address search/resolve; products/estimate; reviewed ride challenge; ride confirm; current status; cancellation preview/confirm.
- No model-visible monitor, outbox, credential, raw-coordinate, payment-ID, or idempotency tool.
- Pickup/drop-off begin as human address queries. A separately approved server-side geocoder returns opaque candidates; resolution creates HMAC-signed private `locationRef` values. Coordinates remain in `0600` private records and are never accepted from the model.
- The v5 recipient guard's production issuer signs v2 proofs over authenticated owner principal, conversation, new inbound message ID and normalized full body, run ID, exact action, complete argument digest, and tool-call ID. The guard overwrites any untrusted proof in `before_tool_call`.
- A ride/cancellation confirmation works only from a **new** owner message and a **new** run, in the same principal/conversation, whose entire normalized body is exactly `RIDE ######` or `CANCEL ######`.
- Mutation idempotency is server-generated from action + challenge ID + immutable payload digest. Durable exclusive claims are fsynced. Unknown POST/DELETE outcomes are quarantined and never retried automatically.
- Before `POST /requests`, both configured aliases and the selected alias are revalidated through official `GET /v1.2/payment-methods`. Raw IDs exist only in the Keychain session and outgoing official request.
- OAuth refresh-token rotation is validated and committed directly back to macOS Keychain through `KeychainWriteHelper.swift`; secret bytes travel on stdin, never argv, logs, env, or disk.
- Restart-persistent local rate limits protect reads, mutations, geocoding, monitoring, and OAuth refresh.
- Private state is `0700`; records and the append-only SHA-256 hash-chained ledger are `0600`.
- Internal monitoring checks only locally confirmed rides. When official `pickup.eta <= 3`, it enqueues one durable normalized alert and stops polling that ride. Delivery is pending → claimed with lease → delivered by acknowledgment. A failed send is released with exponential backoff. The iMessage delivery adapter must use the event `dedupeKey` as its own idempotency key before acknowledging.
- Strict MCP initialization, one-MiB input cap, JSON-RPC method/parameter errors, no batches, and sanitized tool errors.
- All Uber/geocoder output is treated as untrusted data, normalized, bounded, and never interpreted as instructions.

## Current production blockers

The module intentionally remains disabled until **both** are provided:

1. macOS Keychain service `openclaw-uber`, account `alan`, containing the official OAuth bundle, privileged ride-booking/request scope, payment-method read scope, and reviewed personal/business aliases.
2. A separately reviewed server-side address geocoder adapter. The default adapter is `DisabledGeocoderAdapter` and fails closed. A model may never supply latitude/longitude or self-assert that a geocode was verified.

A visible signed-in Uber browser session is not an acceptable fallback. Uber describes `request` as privileged; newer migration material names `ride_request.ride_booking`, `ride_request.estimate`, and `ride_request.user_payment_methods`. Production access beyond registered developers may require Uber Full Access.

The documented Riders API request flow is on-demand, and its `fare_id` expires quickly. This server rejects dispatch more than 90 seconds away. It does not present a local timer as an Uber Reserve booking.

## Keychain bundle contract

The Keychain item is one exact JSON object. Provision it through a reviewed stdin-based Keychain setup path—never a shell argument or repository file.

```json
{
  "schema": "openclaw.uber.oauth-bundle",
  "version": 1,
  "enabled": true,
  "environment": "production",
  "apiBaseUrl": "https://api.uber.com",
  "oauthBaseUrl": "https://auth.uber.com",
  "clientId": "REDACTED",
  "clientSecret": "REDACTED",
  "accessToken": "REDACTED",
  "refreshToken": "REDACTED",
  "tokenType": "Bearer",
  "expiresAt": "2026-09-01T00:00:00.000Z",
  "scopes": ["request", "offline_access"],
  "invocationHmacKey": "DISTINCT_BASE64_32_BYTE_KEY",
  "locationHmacKey": "DISTINCT_BASE64_32_BYTE_KEY",
  "paymentAliases": {
    "personal": "OPAQUE_UBER_PAYMENT_METHOD_ID",
    "business": "OPAQUE_UBER_PAYMENT_METHOD_ID"
  },
  "approval": {
    "privilegedRequestApproved": true,
    "ownerAuthorized": true,
    "approvedAt": "2026-08-15T00:00:00.000Z",
    "expiresAt": "2027-08-15T00:00:00.000Z",
    "reference": "UBER-DEVELOPER-APP-REFERENCE"
  }
}
```

## Integration seams

- Model MCP: `node /Users/alan/OpenClawStudio/UberMCP/index.mjs`
- Guard-only proof issuer: `InvocationProofIssuerV5` in `proof-issuer.mjs`; never register it as a tool.
- Internal scheduler: import `createDefaultService()` and call `monitorTick()` from the reviewed local worker. This method is absent from MCP `tools/list` and `callTool`.
- Internal delivery worker: claim with `claimArrivalAlert(workerId, leaseMs)`, send through the existing governed owner iMessage adapter using `event.dedupeKey`, then call `acknowledgeArrivalAlert`. Call `releaseArrivalAlert` on a definitive send failure.
- No live config or LaunchAgent is installed by this module.

## Offline verification

```sh
cd /Users/alan/OpenClawStudio/UberMCP
npm test
npm run selftest
/usr/bin/swiftc -typecheck KeychainWriteHelper.swift
```

Tests use fake Uber/geocoder sessions and never perform a live network call, ride, cancellation, or message.

## Official primary references

- <https://developer.uber.com/docs/riders/references/api>
- <https://developer.uber.com/docs/riders/ride-requests/tutorials/api/curl>
- <https://developer.uber.com/docs/riders/guides/scopes>
- <https://developer.uber.com/docs/riders/references/api/v1.2/payment-methods-get>
- <https://developer.uber.com/docs/riders/ride-requests/tutorials/api/best-practices>
