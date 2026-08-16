# Governed OpenTable MCP for OpenClaw Studio

This module gives Rico an official-API-only OpenTable seam without weakening the iMessage listener. It is intentionally **not enabled or installed in live OpenClaw configuration** by this change.

## Current state

- The MCP server is local stdio JSON-RPC. It opens no listener and performs no background polling.
- macOS Keychain is the only credential source: service `openclaw-opentable`, account `alan`.
- Missing/disabled/expired Keychain approval fails closed. Only an official OpenTable link remains available.
- A signed-in OpenTable consumer browser session is **not used**. The module does not read cookies, scrape pages, replay consumer requests, or automate a password.
- The only accepted booking contract is `consumer-v2` approved specifically for a visually accessible iMessage flow. The Voice AI/In-House API is rejected because OpenTable says those API families are not interchangeable.
- Card holds, deposits, prepayments, and Experiences are not booked. Rico returns the official OpenTable link instead of collecting payment data.
- State-changing calls need an immutable preview plus a **new** authenticated owner iMessage for each transition. The normalized entire inbound body must be exactly the displayed `HOLD`, `BOOK`, or `CANCEL` challenge. Its message ID and agent-run ID must both differ from the message/run that created the challenge.

## Official constraints implemented

OpenTable requires prospective integrations to obtain partner approval and says production access follows review and a formal agreement. Its documentation also says APIs may only be accessed by the documented means and with credentials assigned for the applicable API. See the [official API documentation](https://docs.opentable.com/), [partner application](https://www.opentable.com/restaurant-solutions/api-partners/become-a-partner/), [partner FAQ](https://www.opentable.com/restaurant-solutions/api-partners/faqs/), and [developer terms](https://www.opentable.com/restaurant-solutions/api-partners/terms-and-conditions/).

The implementation follows these current official Consumer API v2 contracts (reviewed 2026-08-15):

| Capability | Official contract used |
|---|---|
| OAuth | Client credentials at `/api/v2/oauth/token?grant_type=client_credentials` |
| Directory | `GET /sync/directory` (Consumer Partners only) |
| Availability | `GET /v2/availability/{rid}` |
| Booking policy | `GET /v2/booking-policies/{rid}/{date}/{time}/{partySize}?dinerContext=details` |
| Cancellation policy | `GET /v2/cancellation-policies/{rid}/{policyId}` |
| Slot lock | `POST /v2/booking/{rid}/slot_locks` |
| Create reservation | `POST /v2/booking/{rid}/reservations` |
| Get reservation | `GET /v2/booking/{rid}/reservations/{rid}-{confirmation}` |
| Cancel web reservation | `PUT /v2/booking/{rid}/reservations/{rid}-{confirmation}` with status `CancelledWeb` |

OpenTable documents a hard five-minute slot-lock window, directs clients to release unused locks, requires the reservation to be made before expiry, and calls for unique `X-Request-Id` values on write requests. This module persists each mutation claim before networking and never automatically retries an outcome-unknown mutation.

## Tools

1. `opentable_status` — local readiness only; no network probe.
2. `opentable_restaurant_search` — approved Directory API, or an official OpenTable link when unavailable.
3. `opentable_availability_search` — standard non-payment slots only.
4. `opentable_booking_preview` — retrieves policies and creates an immutable local preview.
5. `opentable_booking_hold` — requires the exact `HOLD 123456` challenge and creates the temporary OpenTable lock.
6. `opentable_booking_confirm` — requires a separate exact `BOOK 123456` challenge and explicit policy acceptance.
7. `opentable_reservations_list` — private local ledger of reservations created by this server, not an account scrape.
8. `opentable_cancel_preview` — re-reads the reservation, validates cutoff/status, and discloses consequences.
9. `opentable_cancel_confirm` — requires the exact `CANCEL 123456` challenge.

## Required iMessage flow

```text
Alan → Rico: Find a table for two at Example Restaurant tomorrow at 7.
Rico → Directory + availability → presents exact options.
Alan → Rico: Use 7:00 indoors.
Rico → booking preview → shows restaurant policies and “HOLD 123456”.
Alan → Rico: HOLD 123456
Rico → temporary OpenTable slot lock → shows expiry and “BOOK 654321”.
Alan → Rico: BOOK 654321
Rico → real reservation → returns confirmation and management link.
```

Other group participants cannot create or cancel reservations. Recipient Guard v5 must authenticate Alan's exact iMessage identity before it injects a proof. A challenge is bound to Alan, the originating conversation, the source message, and the source agent run, so it cannot be moved to another chat or chained from a tool result.

Challenge normalization is deliberately narrow: Unicode NFKC, CRLF/CR converted to LF, then leading/trailing whitespace removed. Nothing else is removed or rewritten. `HOLD 123456 please`, `@rico HOLD 123456`, an emoji, quoted text, or a challenge embedded in a longer message all fail. While a challenge is pending, the owner route must recognize an exact bare challenge as an inbound trigger without requiring an `@rico` prefix; the MCP server still proves that it matches the active challenge.

## Keychain bundle

Do not put this JSON in a file, shell argument, environment variable, OpenClaw config, or clipboard manager. After OpenTable approves the integration, create a **Generic Password** item in Keychain Access with service `openclaw-opentable` and account `alan`, and enter the reviewed bundle as the password value.

The following is a schema illustration only:

```json
{
  "schema": "openclaw.opentable.partner-credentials",
  "version": 1,
  "enabled": true,
  "environment": "production",
  "apiFamily": "consumer-v2",
  "clientId": "<OpenTable-issued client ID>",
  "clientSecret": "<OpenTable-issued client secret>",
  "apiBaseUrl": "https://platform.opentable.com",
  "oauthBaseUrl": "https://oauth.opentable.com",
  "invocationHmacKey": "<32 random bytes, base64>",
  "diner": {
    "firstName": "<reviewed diner first name>",
    "lastName": "<reviewed diner last name>",
    "email": "<reviewed diner email>",
    "phone": {
      "countryCode": "US",
      "number": "<E.164 diner phone>",
      "type": "Mobile"
    }
  },
  "approval": {
    "partnerApproved": true,
    "appReviewed": true,
    "agreementReference": "<OpenTable agreement/reference>",
    "contractDocumentSha256": "<64 lowercase hex characters>",
    "approvedCapabilities": [
      "directory",
      "availability",
      "booking_policy",
      "cancellation_policy",
      "slot_lock",
      "book",
      "get_reservation",
      "cancel"
    ],
    "approvedInterface": "consumer-visual-imessage",
    "approvedAt": "<ISO-8601 timestamp>",
    "expiresAt": "<ISO-8601 timestamp>"
  }
}
```

Sandbox and production hosts are pinned in code. A host supplied in a partner welcome message that differs from the current official host requires a reviewed code update; it is not accepted dynamically.

## OpenClaw integration seam (not applied)

After partner approval:

1. Back up `~/.openclaw/openclaw.json` with a timestamp.
2. Register the stdio server using the exact Node executable and this absolute entry point:

   ```json
   {
     "command": "/opt/homebrew/opt/node/bin/node",
     "args": ["/Users/alan/OpenClawStudio/OpenTableMCP/index.mjs"]
   }
   ```

3. Keep every shared-audience tool denied. Permit these OpenTable tools only on the authenticated owner iMessage route.
4. Implement the following exact `before_tool_call` contract for Recipient Guard v5:

   - The model omits `invocation_proof`; it is intentionally optional in the published input schemas and must never be synthesized.
   - Match only the nine exact tool names exported by this module. Do not use a prefix or wildcard allowance.
   - Read canonical sender handle, channel, iMessage message ID, raw entire message body, conversation ID, and agent run ID from the trusted channel envelope—not from model arguments.
   - Delete any caller/model-supplied `invocation_proof` before doing anything else. It is untrusted even if it looks well formed.
   - Require `rico-recipient-guard/v5`, channel `imessage`, and the exact authenticated owner identity. Deny the tool call if any trusted envelope field is absent.
   - `opentable_status` is the sole proof-free, no-network tool. Map each of the other eight exact tool names to one exact action (`restaurant.search`, `availability.search`, `booking.preview`, `booking.hold`, `booking.confirm`, `reservation.list`, `cancel.preview`, or `cancel.confirm`).
   - Import `InvocationProofIssuer` from `proof-issuer.mjs` and issue one action-scoped, two-minute proof from the trusted envelope. The issuer hashes the entire normalized body, message ID, conversation ID, and run ID; raw values are not placed in the token.
   - Overwrite `params.invocation_proof` with that newly issued v5 proof immediately before dispatch. If issuance fails, deny dispatch; never fall through with the supplied value.
   - Permit at most one mutating OpenTable transition per inbound message and per agent run. Do not invoke a follow-on OpenTable mutation from a tool result.
   - Never put the proof in the prompt, transcript, tool result, telemetry, JSONL ledger, or error text.

   The MCP server independently rejects bad signatures, legacy v4 tokens, wrong actions, expiry, a reused source message ID, a reused source run ID, a different conversation, and any `HOLD`/`BOOK`/`CANCEL` proof whose normalized entire message-body digest is not the active challenge.

5. Keep the challenge text in the same iMessage conversation. Do not let the model treat “yes,” an emoji, an `@rico`-prefixed command, or a prior general approval as confirmation.
6. Route the sanitized result back to the same chat. Never expose access tokens, reservation slot tokens, diner contact fields, or raw upstream responses.

The module does not edit `OpenClawPlugin`, Swift UI, scripts, LaunchAgents, or live configuration.

## Local state

Private records live under:

`~/Library/Application Support/OpenClaw Studio/opentable-mcp/`

Directories are forced to mode `0700`; files are `0600`. The ledger excludes OAuth credentials, access tokens, diner email/phone, raw API errors, and iMessage handles. Slot-lock tokens exist only in the private expiring hold record because the final reservation call requires them.

## Offline QA

```sh
cd /Users/alan/OpenClawStudio/OpenTableMCP
npm test
node index.mjs --selftest
```

The test suite uses injected fake HTTP responses. It makes no live OpenTable call and creates no reservation or slot lock.
