# Mobility + Dining integration control layer

This package installs private snapshots of `OpenTableMCP` and `UberMCP` and registers two exact **disabled** stdio entries through OpenClaw's supported `openclaw mcp set` contract. It does not call either API, export a browser session, read a Keychain secret, expose tools to an agent, restart the Gateway, or send an iMessage.

## Commands

```sh
cd /Users/alan/OpenClawStudio/MobilityDiningIntegration
npm test
node index.mjs install
node index.mjs status
node index.mjs rollback
```

The default private root is:

`~/Library/Application Support/OpenClaw Studio/MobilityDiningIntegration/`

Directories are mode `0700` and installed files/manifests/backups are `0600`. Before every install or rollback config mutation, the active `openclaw.json` is copied to a timestamped private backup. The installer calls `openclaw mcp set`/`unset`; it never rewrites or restores the whole config, so unrelated configuration is preserved.

The owned registry names are `rico-opentable` and `rico-uber`. Installation refuses to replace either name if it already exists. Rollback removes an entry only when it still exactly equals the installer-owned disabled value, and removes a file only when its SHA-256 still equals the installed snapshot. Changed entries and files are preserved and reported.

The status command performs an offline stdio initialize/tool-list probe and a metadata-only Keychain existence check. It never uses `security ... -w`, validates no secret bundle, and makes no service request. A signed-in OpenTable or Uber consumer browser session is intentionally not accepted as a credential.

## Credential setup (read-only guidance)

### OpenTable

1. Apply through the official OpenTable API partner program and obtain approval for the Consumer API v2 reservation flow used by a visual iMessage interface.
2. Complete OpenTable's application review and contract process. A normal diner login does not grant partner API access.
3. After approval, create a macOS **Generic Password** item in Keychain Access with service `openclaw-opentable` and account `alan`. Provision the reviewed bundle directly in Keychain Access or another separately reviewed stdin-only setup flow.
4. Do not paste the bundle into Studio, this CLI, a shell argument, environment variable, JSON config, log, or browser automation.

Official references: [OpenTable API documentation](https://docs.opentable.com/), [partner application](https://www.opentable.com/restaurant-solutions/api-partners/become-a-partner/), and [partner terms](https://www.opentable.com/restaurant-solutions/api-partners/terms-and-conditions/).

### Uber

1. Create an Uber developer application and complete Uber OAuth for Alan's rider account.
2. Obtain the privileged ride-request/ride-booking capability and any production/Full Access review Uber requires.
3. Resolve the opaque Uber payment method IDs once in a separately reviewed setup flow and bind only the aliases `personal` and `business` in the Keychain bundle.
4. Store that bundle as a macOS **Generic Password** item with service `openclaw-uber` and account `alan`. A signed-in rider website session is not OAuth developer authorization and is never imported.
5. Do not paste tokens, client secrets, refresh tokens, or payment IDs into Studio, this CLI, a shell argument, an environment variable, or OpenClaw config.

Official references: [Riders API](https://developer.uber.com/docs/riders/references/api), [authentication](https://developer.uber.com/docs/riders/guides/authentication/introduction), and [scopes](https://developer.uber.com/docs/riders/guides/scopes).

## Why both entries remain disabled

`status` exposes the current fail-closed blockers. In particular, real activation requires all of the following:

- Upgrade OpenTable to the v2 proof envelope used by Uber: bind the complete canonical tool arguments and exact `toolCallId`, then durably consume that one-shot claim before any network action. OpenTable already binds owner, message, conversation, run, action, expiry, and later-run `HOLD`/`BOOK`/`CANCEL`, but that is not sufficient for activation.
- Deploy the reviewed recipient-guard v5 integration as the sole `before_tool_call` proof injector for both servers. Uber's v2 proof contract is ready for this seam; neither provider is enabled by this package.
- Install and validate official provider credentials in the exact Keychain items. OpenTable additionally requires partner approval; Uber additionally requires privileged ride-request scope and reviewed payment aliases.
- Configure a reviewed server-side geocoder for Uber. The server already uses opaque signed location references and rejects model-authored coordinates, but its default adapter intentionally fails closed.
- Connect Uber's durable ETA event outbox to the reviewed owner-only iMessage sender and a trusted scheduler, with delivery acknowledgement before the event closes.
- Complete a separate activation review that verifies exact native tool policy, hook registration, rate limits, health, and rollback. This package intentionally has no enable command.

This package has no enable command. Using `openclaw mcp configure ... --enable` before those fixes would violate the integration contract.

## Exact later guard and tool-policy seams

After the blockers are fixed, the recipient guard must be the sole proof issuer. In `before_tool_call`, it must authenticate the exact owner sender and conversation from trusted run context, reject model-supplied proof material, bind the current inbound message ID/body digest and canonical tool-argument digest, mint an action-specific short-lived one-shot proof, and inject it only into the matching call. Challenge mutations require a later run and a new exact inbound body. The verifier must consume a persistent one-shot registry entry before mutation networking.

Only the authenticated owner route may receive these provider-prefixed MCP tools:

- `rico-opentable__opentable_status`
- `rico-opentable__opentable_restaurant_search`
- `rico-opentable__opentable_availability_search`
- `rico-opentable__opentable_booking_preview`
- `rico-opentable__opentable_booking_hold`
- `rico-opentable__opentable_booking_confirm`
- `rico-opentable__opentable_reservations_list`
- `rico-opentable__opentable_cancel_preview`
- `rico-opentable__opentable_cancel_confirm`
- `rico-uber__uber_status`
- `rico-uber__uber_location_search`
- `rico-uber__uber_location_resolve`
- `rico-uber__uber_products_estimate`
- `rico-uber__uber_create_reviewed_challenge`
- `rico-uber__uber_confirm_request`
- `rico-uber__uber_current_status`
- `rico-uber__uber_cancel_preview`
- `rico-uber__uber_cancel_confirm`

Shared contacts and non-owner group participants remain denied. Uber's monitor/outbox functions are not MCP tools and must never enter a model/native tool allowlist; only a trusted scheduler may invoke the internal monitor seam.

`eta-handoff.mjs` defines the narrow delivery seam. It accepts only a normalized `openclaw.uber.alert` threshold event, targets the fixed reviewed owner route (never a raw handle), forbids generic send fallback, persists a deduplicated pending item, and accepts only a matching reviewed-sender delivery receipt. It does not dispatch. Uber now persists its own pending/claimed/delivered event state with retry/backoff; production still needs the reviewed sender/scheduler adapter that bridges the two acknowledged outboxes.
