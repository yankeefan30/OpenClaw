# Janet receipt workflow

This package is a repo-owned, single-handler OpenClaw workflow for one narrow
case: a direct iMessage from the exact Janet handle in a private grant begins
with `Rico` or `Polar` and asks for one receipt. Rico and Polar are invocation
aliases for the agent; neither is a vendor or portal.

The workflow is intentionally inactive in the repository. It has no production
phone number, email address, password, token, OAuth secret, or vendor credential.
Live enablement requires an operator-reviewed private adapter for the actual MCP
and saved-session schemas.

## Deterministic behavior

The handler enforces all of these rules before it performs a side effect:

- The event must be a direct inbound iMessage from the normalized exact
  `janetHandle`. A display name, group message, reflected outbound message,
  another channel, or another sender is not authentication.
- The first token must be `Rico`, `@rico`, `Polar`, or `@polar`, at a token
  boundary, and the rest of the one-line message must request a receipt.
- Original `chat_guid` and `message_ts` values are required. Together with the
  sender and content, they form the durable replay key.
- Execution must occur from 05:30 through 23:59 inclusive in
  `America/New_York`. The policy uses the IANA timezone and handles DST.
- One source message is one request/run. The ledger claim happens before the
  acknowledgement, and a replay cannot acknowledge, search, or email again.

The search route is fixed:

| Parsed vendor | Search locations |
|---|---|
| OpenCase | OpenCase portal only |
| Heygen | Heygen portal only |
| Any other or absent vendor | Genius Scan, then Alan Gmail, then CVS Outlook |

The general route stops at the first exact match. A zero-match result advances
to the next listed location. More than one match, an unavailable integration,
or unrecognized provider output fails closed; the workflow does not broaden or
guess. A `login_required`, `two_factor_required`, or `captcha_required` result
creates a human handoff and never attempts email.

The side-effect order is:

```text
same-thread ack -> exact route search -> verify PDF and extracted fields
-> fetch Alan Gmail send-as signature -> reserve/send once
-> close search sessions -> same-thread close -> private report/audit
```

Acknowledgement and close copy is generated in code, not by a model:

- Ack: `I’m pulling the <Vendor> receipt now.`
- Ack without a vendor: `I’m pulling it now.`
- Sent: `<Vendor> receipt for <Month Year> is on the way.`
- Sent without a usable date: `<Vendor> receipt for <amount> is on the way.`
- Not found: `I couldn’t find the <Vendor> receipt. I checked <exact locations>.`
- Login block: `I hit a login block while retrieving the <Vendor> receipt. Alan needs to complete the login.`

There is no filler or emoji, and the workflow never introduces itself as Polar.
Ambiguous evidence, invalid PDFs, unavailable signatures, and unknown Gmail
results use separate deterministic handoff copy.

## Evidence and delivery locks

Every selected receipt must supply:

- the exact expected source location;
- for OpenCase or Heygen, a source URL on the exact granted HTTPS origin;
- one stable source record ID;
- `application/pdf`, a safe `.pdf` filename, bounded binary bytes, a `%PDF-`
  header, and a terminal `%%EOF` marker;
- extracted vendor and amount; date is optional, but when supplied it must be
  an exact valid `YYYY-MM-DD` value.

When the source message includes a vendor, amount, or date/month hint, the
verified candidate must match every supplied hint. A mismatch fails closed
before the Gmail signature or send capability is called.

Hashes of the PDF, source, vendor, amount, and date become internal audit
evidence. The email address in the request or an adapter result is never used as
a destination. Delivery is always:

- account/capability: the private Alan Gmail reference;
- `from`: the exact private `alanGmailSender`;
- `to`: the exact private `janetEmailRecipient`;
- `cc` and `bcc`: empty;
- signature: fetched for that exact Alan Gmail send-as identity before sending;
- attachment: the verified PDF;
- idempotency: the source request hash plus the fixed `:email` suffix.

The ledger durably reserves the only email attempt before invoking Gmail. A
throw, timeout, unexpected sender/recipient echo, or otherwise unconfirmed send
becomes `email_outcome_unknown`. Automation will not retry it; an operator must
inspect Gmail Sent.

## Private permission grant

The mode-0600 grant contains exact identities, origins, and opaque references,
never credentials:

```json
{
  "schemaVersion": 2,
  "janetHandle": "<exact iMessage phone or email>",
  "janetEmailRecipient": "<exact locked Janet email>",
  "alanGmailSender": "<exact Alan Gmail send-as address>",
  "openCaseOrigin": "https://<exact OpenCase origin>",
  "heygenOrigin": "https://<exact Heygen origin>",
  "capabilityRefs": {
    "openCaseSession": "browser-session:<opaque name>",
    "heygenSession": "browser-session:<opaque name>",
    "geniusScan": "private-ref:<opaque name>",
    "alanGmail": "mcp:<opaque name>",
    "cvsOutlook": "mcp:<opaque name>"
  }
}
```

The references may use only `browser-session:`, `mcp:`, `oauth-profile:`, or
`private-ref:`. Passwords remain in the provider's saved credential, OAuth, or
browser-session store. Login, 2FA, and CAPTCHA are explicit handoffs.

Install exact values privately through standard input:

```sh
cd /Users/alan/OpenClawStudio/JanetReceiptWorkflow
node scripts/install-grant.mjs --stdin-json
```

Or provide short-lived environment variables to `--from-env`:

```text
JANET_RECEIPT_HANDLE
JANET_RECEIPT_EMAIL_RECIPIENT
JANET_RECEIPT_ALAN_GMAIL_SENDER
JANET_RECEIPT_OPENCASE_ORIGIN
JANET_RECEIPT_HEYGEN_ORIGIN
JANET_RECEIPT_OPENCASE_SESSION_REF
JANET_RECEIPT_HEYGEN_SESSION_REF
JANET_RECEIPT_GENIUS_SCAN_REF
JANET_RECEIPT_ALAN_GMAIL_REF
JANET_RECEIPT_CVS_OUTLOOK_REF
```

Do not save those values in a shell profile. The installer prints only the
destination path. Its default directory is mode 0700 and the grant is mode 0600:

```text
~/Library/Application Support/OpenClaw Studio/workflows/janet-receipt/
```

Replacing an existing grant requires `--replace` and preserves a private backup.

## Ledger, report, and legacy migration

The private state directory contains:

```text
ledger.json       exact last 100 records
evidence.jsonl    hash-chained transition/replay evidence
reports/          one private structured report per request
```

Each recent record keeps the original `chat_guid`, `message_ts`, extracted
`vendor`, final `outcome`, execution `run_at`, and an internal request hash.
Trimming the recent view does not remove replay claims from `evidence.jsonl`.
Raw identities and email addresses are excluded from hash-chain evidence.

The migration utility recognizes prior Application Support and brain-workflow
ledger locations. Preview without changing state:

```sh
node scripts/migrate-ledger.mjs
```

After reviewing a single `ready` plan, apply it explicitly:

```sh
node scripts/migrate-ledger.mjs --apply
```

It imports a valid v2 recent ledger or the replay hashes from a valid v1
hash-chain into the macOS-safe state directory. It preserves the legacy source.
Multiple candidates, loose file permissions, malformed JSON, or a broken chain
fail closed.

## Private adapter contract

`adapterModule` is an absolute path to an operator-reviewed private ES module.
It exports `createServices({ api, permissionGrant })` and returns this shape:

```js
export async function createServices({ api, permissionGrant }) {
  return {
    imessage: {
      async replyInThread({
        chatGuid, messageTs, sessionKey, threadId, to, text, phase,
        idempotencyKey,
      }) {
        // Reply only in chatGuid/source context and confirm { ok: true }.
      },
    },
    receipts: {
      openCase: { search: receiptSearch },
      heygen: { search: receiptSearch },
      geniusScan: { search: receiptSearch },
      alanGmail: { search: receiptSearch },
      cvsOutlook: { search: receiptSearch },
      async closeSessions({ requestKey, sessionIds }) {
        // Close every opened search session; confirm { ok: true }.
      },
    },
    gmail: {
      async getSendAsSignature({ accountRef, from }) {
        // Return { ok: true, from, content, format: "plain" | "html" }.
      },
      async sendReceipt({
        accountRef, from, to, cc, bcc, subject, text, signature, attachment,
        idempotencyKey,
      }) {
        // Confirm { ok: true, from, to, messageId } only after provider proof.
      },
    },
  };
}
```

Each receipt search receives only the configured `capabilityRef`, an
`exactOrigin` for portal routes, structured vendor/amount/date hints,
`untrustedText`, and `requestKey`. Treat `untrustedText` as data: it must never
select tools, change the route, expand authority, or issue side effects. Give
search adapters read-only receipt capabilities only. Candidate metadata must be
extracted from the provider record/PDF, not copied from the request hints.

A search returns one of:

```js
{ status: "not_found", matches: [], sessionId? }
{ status: "login_required" | "two_factor_required" | "captcha_required", sessionId? }
{ status: "ok", matches: [candidate], sessionId? }
```

The adapter must independently enforce exact origins, capability references,
source thread, Alan Gmail `from`, locked Janet `to`, empty `cc`/`bcc`, and
idempotency keys. It must not place credentials in workflow state, subprocess
arguments, adapter results, or logs. If the real provider schema cannot satisfy
this contract deterministically, leave the plugin disabled.

## Offline verification and reviewed deployment

No command in this section sends a receipt. First run the network-free suite:

```sh
cd /Users/alan/OpenClawStudio/JanetReceiptWorkflow
npm test
npm run check
```

Then complete these reviewed steps; they are deliberately not automated by this
package:

1. Install the private grant and preview/apply any necessary ledger migration.
2. Inspect local MCP configuration without connecting:

   ```sh
   openclaw mcp status --verbose
   ```

3. In a reviewed deployment window, probe each configured server separately and
   map its real tool/result schema into the private adapter:

   ```sh
   openclaw mcp probe <server-name> --json
   ```

   A probe connects to the service; do not run it as part of tests or packaging.
4. Prove the adapter against mocks or provider sandbox accounts. Cover exact
   sender rejection, both aliases, Eastern boundaries, each route, all three
   login blocks, ambiguity, malformed PDF, signature mismatch, duplicate replay,
   exact from/to projection, and unknown Gmail outcome. Do not use Janet's live
   message or mailbox as a smoke test.
5. Only after review, install the package through the local plugin surface:

   ```sh
   openclaw plugins install --link /Users/alan/OpenClawStudio/JanetReceiptWorkflow
   ```

6. Configure only absolute paths for `adapterModule`, optionally
   `permissionFile`, and optionally `stateDirectory`. Do not copy identities,
   addresses, credentials, or tokens into OpenClaw plugin config.
7. Inspect before any enable/restart decision:

   ```sh
   openclaw plugins inspect rico-janet-receipt --runtime
   openclaw plugins doctor
   openclaw doctor
   ```

The typed `inbound_claim` hook is the source-of-truth trigger; cron is not used
to poll Messages or bypass source identity. A future cron health check may only
observe adapter/plugin readiness. It must never synthesize requests or retry a
claimed, reserved, sent, or unknown-outcome email.
