# Rico Outlook mail monitor

This package is a disabled-by-default OpenClaw 2026.7.1-2 plugin for two
operator-authorized mail metadata monitors:

- every 90 seconds, detect new mail in one exact folder directly under Inbox;
- every 90 seconds, detect new Inbox mail from one exact SMTP address;
- send each monitor's exact private alert text to one exact iMessage destination
  from one exact, proven Messages source identity.

The repository intentionally contains no mailbox, folder name, sender address,
Apple account, phone number, alert copy, OAuth token, or password. Those values
live only in the operator's mode-`0600` permission grant. Installing the plugin
does not activate it.

## Why a private adapter is required

The installed OpenClaw build exposes a supported long-lived plugin service and
Gateway status RPC. It does not expose a typed Outlook/Graph client to a plugin.
Its generic iMessage `--account` option chooses an OpenClaw channel account
(profile/CLI/database), not a cryptographic or runtime proof of the Apple sender
identity. The installed `imsg send` command has no source-account option.

Consequently this plugin will not approximate either boundary. An
operator-reviewed private adapter must prove:

1. it is reading the exact authorized Outlook mailbox using metadata-only,
   immutable-ID delta queries;
2. it resolved the exact folder path, with no fuzzy match;
3. it compares the sender's SMTP address exactly (case-insensitive), never the
   display name;
4. its delta query returns created items only, not message updates;
5. it can prove the active Messages source identity before sending, disables
   SMS fallback, enforces the supplied idempotency key, and returns those proofs
   with the confirmed delivery result.

Until that adapter exists and passes preflight, status is `blocked` and no text
is attempted.

## Microsoft Graph adapter guidance

The least-privilege Graph implementation uses delegated `Mail.ReadBasic`,
resolves the named child folder underneath the well-known Inbox folder, and
uses message delta queries. Every message/delta request must include:

```text
Prefer: IdType="ImmutableId"
```

Only `id`, `receivedDateTime`, and `sender.emailAddress.address` should be
selected. Never request or return subject, preview, body, attachments, or
recipient fields. During an initial `baselineOnly` call, the adapter must drain
all `@odata.nextLink` pages through the final `@odata.deltaLink` but may return
no existing items. On later calls it must drain the delta round completely and
return every created item plus the final delta cursor; if the round exceeds the
contract's `maxItems`, throw without returning a cursor so the plugin cannot
silently skip mail.

Primary references:

- <https://learn.microsoft.com/graph/outlook-immutable-id>
- <https://learn.microsoft.com/graph/api/message-delta?view=graph-rest-1.0>
- <https://learn.microsoft.com/graph/api/mailfolder-list-childfolders?view=graph-rest-1.0>

## Adapter contract

The adapter is an absolute, owner-controlled, mode-`0600` `.mjs` file exporting:

```js
export async function createOutlookMailMonitorAdapter(context) {
  return {
    async preflight(request) {},
    async pollMetadata(request) {},
    async sendIMessage(request) {},
  };
}
```

`preflight(request)` receives the exact private mailbox, source account, and
destination and must return exactly:

```js
{
  ok: true,
  mailboxId: request.mailboxId,
  metadataOnly: true,
  immutableIds: true,
  createdOnly: true,
  sourceAccount: request.sourceAccount,
  destination: request.destination,
  imessageOnly: true,
  idempotentSends: true,
}
```

`pollMetadata(request)` receives one fixed monitor ID, exact mailbox/folder,
an exact SMTP sender or `null`, the prior opaque cursor, `baselineOnly`, the
three allowed fields, `immutableIds: true`, and `createdOnly: true`. It returns
exactly:

```js
{
  items: [{
    immutableId: "provider immutable id",
    receivedAt: "ISO timestamp",
    mailboxId: request.mailboxId,
    folderPath: request.folderPath,
    senderAddress: "exact SMTP address",
  }],
  nextCursor: "opaque final delta cursor",
}
```

`sendIMessage(request)` receives the private source account, destination,
verbatim alert text, durable idempotency key, and
`requireSourceIdentityProof: true`, `service: "imessage"`, and
`allowSmsFallback: false`. It must return exactly:

```js
{
  ok: true,
  sourceAccount: request.sourceAccount,
  destination: request.destination,
  transportMessageId: "confirmed provider id",
  sourceIdentityProven: true,
  service: "imessage",
  smsFallbackDisabled: true,
}
```

Any missing, extra, or mismatched field fails closed. A send exception or
unproven result is durably recorded as `outcome-unknown` and is never retried,
because the message may already have left the machine.

## Private grant

Create the grant outside shell history. Replace every placeholder locally with
the exact values the operator authorized; do not save a filled copy in this
repository.

```json
{
  "schema": "rico.outlook-mail-monitor-grant",
  "schemaVersion": 1,
  "mailboxId": "WORK_MAILBOX_ADDRESS",
  "folderMonitor": {
    "folderPath": "Inbox/EXACT_CHILD_FOLDER",
    "alertText": "EXACT_OPERATOR_AUTHORIZED_FOLDER_ALERT"
  },
  "senderMonitor": {
    "folderPath": "Inbox",
    "senderAddress": "EXACT_SENDER_SMTP_ADDRESS",
    "alertText": "EXACT_OPERATOR_AUTHORIZED_SENDER_ALERT"
  },
  "imessage": {
    "sourceAccount": "EXACT_MESSAGES_SOURCE_ACCOUNT",
    "destination": "+1E164_DESTINATION"
  },
  "issuedAt": "2026-01-01T00:00:00.000Z"
}
```

Install from stdin (the script never prints the grant):

```bash
cd /path/to/OutlookMailMonitor
node scripts/install-grant.mjs --stdin-json < /private/path/grant.json
```

The parent directory is forced to `0700`; grant, adapter, cursor, and dedupe
files are required to be `0600`. Symbolic links and wrong-owner files are
rejected. An existing directory with broader permissions is rejected rather
than automatically chmodded, preventing a mistaken broad path from changing
unrelated filesystem permissions.

## OpenClaw configuration

After the private adapter and grant have been reviewed, configure absolute
paths under `plugins.entries.rico-outlook-mail-monitor.config` and explicitly
set that plugin-config object's `enabled: true`. Restart the Gateway so its
startup service loads. Verify the read-only RPC:

```text
rico.outlook-mail-monitor.status
```

Healthy state is `running`. `disabled`, `blocked`, or `attention` means no new
delivery should be trusted; `attention` specifically means a transport outcome
could not be proven and was quarantined without retry.

## Delivery and dedupe semantics

- The first successful poll creates delta baselines for both streams and sends
  nothing for existing mail.
- An item at or before the baseline timestamp that appears late is marked
  `late-baseline`, not alerted.
- Immutable identities are SHA-256 hashed with mailbox scope before storage.
  Dedupe is shared across both streams, so moving the same item between the two
  monitored folders cannot create a second alert. Raw message IDs are never
  persisted by the plugin.
- A reservation is durably written before each send. Confirmed, uncertain, and
  baseline outcomes are retained (bounded to 2,000 per stream).
- Empty polls produce no log or text. Repeated identical failures produce no
  repeated log noise; status retains the machine-readable blocker.
- Polls never overlap. The service lifecycle clears the exact 90-second timer
  during Gateway shutdown.

## Offline QA

Tests use fictional identities, temporary directories, and fake adapters. They
do not open Outlook, query Graph, inspect Messages, or send iMessages.

```bash
cd OutlookMailMonitor
npm test
npm run check
```
