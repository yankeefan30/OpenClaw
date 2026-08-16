# Rico email governance

This module is the fail-closed enforcement seam for per-person email authority
and the meeting-request handoff. It is deliberately not an OpenClaw plugin by
itself: a real Outlook adapter must be reviewed and installed before the
Gateway integration enables either path.

No credential, email body, phone number, contact identifier, or recipient
address is written to the delivery ledger. Ledger evidence contains only
hashes, bounded counts, status, and safe error codes.

Conversation-derived notes may inform Rico's internal reasoning only after
Alan reviews them. Outgoing text and email must never name or imply the
underlying conversation, message, transcript, recording, meeting recording,
lifelog, Limitless, or PLAUD. `policy.mjs` enforces this again on the final
subject/body immediately before delivery; prompt instructions are not treated
as sufficient enforcement.

## Person authorization contract

Studio writes a private profile-side authorization with this exact shape:

```json
{
  "schema": "rico.person-email-authorization",
  "schemaVersion": 1,
  "profileId": "stable-profile-id",
  "contactIdentifierHash": "<sha256 of CNContact.identifier>",
  "displayName": "Reviewed display name",
  "principal": {
    "kind": "phone",
    "handle": "+12125550123"
  },
  "email": {
    "enabled": true,
    "attachmentsAllowed": false,
    "recipientEmail": "selected-address@example.com",
    "recipientSource": {
      "kind": "macos-contacts-reviewed-email",
      "contactIdentifierHash": "<same contact hash>",
      "emailValueHash": "<sha256 of normalized recipientEmail>",
      "reviewedAt": "2026-08-15T12:00:00.000Z"
    },
    "senderAccount": "alan.a.rosa@gmail.com",
    "client": "outlook"
  },
  "revision": 1,
  "authorizedAt": "2026-08-15T12:00:00.000Z"
}
```

`recipientEmail` must come from the linked macOS Contact's reviewed email
values. The Studio UI must use a picker; it must not expose a free-text email
field. Runtime binds the recipient proof to the same contact hash and exact
normalized email value.

Studio's canonical v1 principal encoding is `{kind:"phone|email",handle}`.
The runtime accepts the earlier internal
`{channel:"imessage",kind:"direct",handle}` form only as a strict migration
input and normalizes both forms to one direct iMessage principal. It never
accepts a display name as a principal.

The only valid source accounts are:

- `alan.a.rosa@gmail.com`
- `alan.rosa@cvshealth.com`

There is no source-account fallback. `attachmentsAllowed` is a separate grant
and can never be true while `enabled` is false.

## Adapter boundary

The adapter is trusted integration code and must implement:

- `verifyInboundPrincipal(request)`
- `preflightEmailSend(request)`
- `sendEmail(request)`
- for meeting handoffs, `preflightThreadReply(request)` and
  `replyInThread(request)`

The normalized proofs in `adapter-contract.mjs` require:

- an exact direct inbound iMessage principal from
  `openclaw-gateway-exact-principal`;
- the immutable message and conversation IDs plus the exact body hash;
- the Outlook desktop client bundle identity `com.microsoft.Outlook`;
- exact source-account and recipient proofs;
- an explicit no-sender-fallback guarantee;
- idempotent sends and same-thread replies.

An adapter exception or incomplete post-send proof is `outcome-unknown`. The
claim remains quarantined and is never retried, because delivery may have
occurred.

`native-outlook-adapter.mjs` implements the reviewed mail-only adapter against
Microsoft Outlook's installed Apple-event dictionary. It verifies the exact
`com.microsoft.Outlook` app and exact configured source account, passes email
content to `osascript` over stdin (never command-line arguments or a file),
constructs explicit To/Cc recipients with no Bcc, re-proves the draft's source
account and recipient sets before send, and keeps a second private at-most-once
claim. An uncertain outcome remains claimed and is never retried. Sending is
disabled by default and must be enabled by the reviewed Gateway integration;
the adapter does not provide iMessage identity proof.

## Group requests

`GroupEmailBroker` permits one email to originate from an authenticated,
approved group iMessage without treating the whole group as the audience of
the email. It requires:

- exact Gateway proof of the original message, sender, group target, body
  hash, and unchanged reviewed group membership;
- at least one explicit literal person mention assigned to `to` or `cc`;
- a unique reviewed person authorization for every mentioned recipient;
- one common exact Outlook source account across all selected recipients;
- independent attachment permission from every selected To/Cc recipient.

Group membership is admission evidence only. It is never expanded into an
email list, a group name never becomes a recipient, and Bcc is forbidden. The
meeting handoff path requires Janet's reviewed
`janet.cummings@cvshealth.com` address as the sole To recipient; explicitly
mentioned approved people may be copied. Its subject/body are generated by
the same meeting handoff builder, receive the enforcement-owned signature,
and pass the private-provenance gate.

`GroupEmailToolExecutor` is the tool-facing seam. Its model-visible schema
contains only opaque profile IDs, reviewed display names, literal mention
text, and explicit To/Cc roles. Raw recipient addresses, source accounts,
group participants, and Bcc are absent. The host supplies `runtimeContext`
out-of-band, and `verifyRequestOrigin` must resolve it through the recipient
guard's private run registry into a `rico-recipient-guard/v5` group-origin
proof. Private profile and group providers then load the reviewed state; a
model cannot supply it. The recipient guard resolves the private run registry
into a `rico-recipient-guard/v5` group-origin proof.

## Attachments

Every attachment requires all of the following:

- the person's independent attachment permission;
- an absolute regular file owned by the current user;
- no symbolic link;
- a real path inside a configured allowed root;
- a matching byte count and SHA-256 digest;
- no more than five files, each no larger than 25 MiB.

## Meeting handoff

`MeetingHandoffEngine` never creates, edits, moves, cancels, accepts, or sends
an invitation. `assertToolActionAllowed` is the integration hook that must be
installed before every tool call so profile instructions cannot override this
rule. Read-only calendar inspection remains separate.

A qualifying direct request receives the exact owner-supplied response. A
separate private grant authorizes one Outlook-only email to
`janet.cummings@cvshealth.com`; the grant must select one exact source account.
The email subject is `Meeting has been requested by <reviewed name>`, states
who requested the meeting and when in Eastern time without quoting or
referencing the private conversation, states that Rico did not create a
calendar event, and receives the exact enforcement-owned signature:

`Rico an Autonmous Agent on behalf of Alan Rosa`

The reply and email have independent atomic claims, so a crash cannot turn a
retry into a duplicate. No live send is performed by tests.

## Integration API

```js
import {
  AuthorizedPersonEmailDispatcher,
  DeliveryLedger,
  GroupEmailBroker,
  GroupEmailToolExecutor,
  MeetingHandoffEngine,
  NativeOutlookAdapter,
  RICO_GROUP_EMAIL_TOOL_DEFINITION,
  assertToolActionAllowed,
  validatePersonEmailAuthorization,
} from "./RicoEmailGovernance/index.mjs";
```

The Gateway integration should:

1. load the private reviewed person profile;
2. call `validatePersonEmailAuthorization`;
3. pass only the immutable inbound reference to the dispatcher/meeting engine;
4. let the adapter re-prove the exact sender rather than trusting a display
   name or model-produced handle;
5. call `assertToolActionAllowed` on every proposed calendar/meeting tool
   mutation;
6. expose blocked status in Studio without exposing private grant contents.

Run focused QA with:

```sh
npm run check
npm test
```
