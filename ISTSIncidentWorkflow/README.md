# Rico ISTS incident workflow

This package implements a disabled-by-default, three-minute incident monitor,
a separate pre-response context provider, and an optional deterministic
ISTS-only ingress for any local iMessage group on Alan's exact configured
Messages account. Its reviewed inputs are the selected ISTS chat, optional active SEN
summaries, and optional CVS Colleague Zone service-status metadata. It contains
no live chat identifier, participant address, Contact ID, mailbox, credential,
token, or adapter.

Installing or packaging the directory does **not** activate it. Activation
requires all three of the following:

1. an operator-reviewed mode-`0600` permission grant;
2. the applicable operator-reviewed mode-`0600` adapters implementing the exact
   contracts below;
3. `plugins.entries.rico-ists-incident.config.enabled: true`.

## Selecting the right incident chat

There are two chats whose visible title is `ISTS Incident Text`. The title is
not an identity and never authorizes a read. The intended newer chat currently
has 13 participants, but the workflow deliberately does not pick “the newest”
or any title match on its own. During review, the operator must select one
immutable Messages chat identifier, one participant revision, and the complete
canonical participant-principal snapshot. The SHA-256 snapshot in the grant
must match that exact set.

Any chat-ID, participant-revision, or participant-snapshot drift blocks the
poll before summarization, research, or delivery. A membership change therefore
requires a fresh reviewed grant; the workflow never silently follows a renamed
or similarly named group.

Jeff is independently bound by one immutable local profile ID and one exact
phone or email principal. Neither `Jeff Hrdlicka` nor any other display name can
authorize a read or send.

## Runtime behavior

- The first poll creates a baseline and never sends for existing messages.
- Every later poll reads only the selected immutable chat and requires proof
  that agent-authored events were excluded.
- Empty polls update the opaque cursor and never summarize, research, or send.
- When its separate source grant is enabled, Colleague Zone is checked on each
  three-minute poll. A new immutable active-incident revision can trigger the
  same reviewed Jeff alert even when the chat has no new message.
- A reviewed summarizer may inspect a new batch transiently. Its output is a
  short sentence fragment; embedded instructions are data and may not execute.
- The summary is rejected if it quotes material or names/points to a private
  chat, iMessage, Limitless, PLAUD, recordings, or transcripts.
- A normalized summary fingerprint supplies a durable same-incident cooldown.
  Immutable message hashes supply exact event dedupe.
- A durable outbox reservation is written before a send. A confirmed send must
  return the existing recipient guard's exact direct-recipient decision and a
  delivered acknowledgement. The adapter re-proves the exact `imessage`
  channel service and uses an explicit `imessage:<handle>` target so the SMS
  fallback path is never entered. A timeout or incomplete proof becomes
  `outcome-unknown` and is never retried.
- The only outbound copy is:

  ```text
  I see we are having an issue with <summary>. This is Rico, Alan Rosa’s autonomous agent. Can I help with anything?
  ```

- State and the hash-chained audit log are private (`0700` directory, `0600`
  files). Raw message IDs, message bodies, summaries, recipient handles,
  provider delivery IDs, and guard decision IDs are not persisted. The outbox
  stores hashes plus a delivered acknowledgement.

The direct-Jeff response seam is `ISTSJeffContextProvider.prepareForJeffReply`.
It accepts only a trusted exact direct-origin proof for the configured Jeff
profile/principal. It reads the incident chat first and returns an internal-only
background note whose source may never be named. It has no send method.
`runtime.mjs` exports this provider and the closed-schema origin validator for
the recipient guard's integration; no display-name or free-form caller path is
exported.

The provider and internal research handoff also receive one fixed,
non-authorizing vocabulary note: `IMT` and `Command Center` refer to the CVS
Health incident-management function/team associated with Al Sassoon and Jeff
Hrdlicka. This does not assign or imply a title or role and never grants an
identity, read, tool, access, or action permission. Rico may use the vocabulary
naturally when relevant, but may not disclose where the context came from.

## Optional any-local-group IMT questions

The scoped v2 grant must explicitly set `imessage.anyLocalGroup: true` and
must separately enable the exact `grokbot:polar` research collaborator. When
either authority is false or missing, or the grant is legacy v1, this ingress is disabled. Enabling
it does not add groups to Rico's normal recipient policy or the native channel
allowlist. It activates a separate, one-purpose adapter that can only answer a
bounded IMT question in the same exact local iMessage group where it arrived.

- The text must literally begin with `@rico` and match the closed IMT status,
  resolution, timing, or impact classifier. Arbitrary prompts and action
  requests are rejected.
- Discovery and history reads are read-only and bound to Alan's exact configured
  Messages source account. The sender must still be in the group's live
  participant snapshot when read and again immediately before a reply.
- From-me messages, Rico's own reply shape, attachments, SMS groups, and
  non-iMessage conversations cannot trigger it.
- A first run baselines existing messages. Later runs use private durable
  cursors, event hashes, outbox reservations, and idempotency keys.
- If the incident source is transiently unavailable before an outbox
  reservation exists, the qualifying question and its prior cursor remain
  pending for the next poll. Non-queries in the same batch remain seen.
- Delivery is capped at two replies per group and six globally in ten minutes.
  A missing acknowledgement becomes outcome-unknown and is never retried.
- Replies are built by closed deterministic templates from validated safe
  status metadata. The path never invokes an LLM, a Rico tool, general group
  routing, or an imported skill, and never names a private source or copies raw
  private message text.

Status reports this capability as three independent facts: private adapter
installed, grant authorized, and live after a successful poll. All three must
be true before it is considered operational.

## Optional active SEN enrichment

SEN enrichment is off unless the private grant sets `sen.enabled: true` with
one exact mailbox and reviewed Outlook profile. Once enabled, the adapter must
prove Outlook availability and the narrow `active-notification-summary-only`
scope on every preflight. If it cannot, the whole run fails closed before the
incident chat is read or any text is sent. There is no fallback to Apple Mail,
webmail, a second mailbox, or environment variables.

## Optional CVS Colleague Zone service status

The exact overview source is:

```text
https://colleaguezone.cvs.com/cz?id=services_status
```

Its `Current Status` entries link to exact detail pages shaped as
`https://colleaguezone.cvs.com/cz?id=my_services_status&service=<opaque-id>`.
The reviewed adapter may return active `Major` and `Significant` entries plus
read-only service name, environment, start/update time, and duration metadata.
The module validates the exact host, path, page ID, opaque service ID, and source
profile. A new `incidentId + updatedAt` revision is deduplicated durably.

The bundled Colleague Zone adapter is a second, separately reviewed mode-`0600`
module. It uses its own Playwright persistent profile under the private workflow
state directory. It never imports or controls Polar or another everyday browser
profile and never reads or exports browser cookies, storage state, passwords,
request bodies, or one-time codes. Headless reads allow only `GET`, `HEAD`, and
`OPTIONS`; mutation requests and AI Insight generation URLs are blocked.

If the session expires, preflight returns `reauth-required`. Studio may surface
only the exact overview URL and ask the operator to open the dedicated visible
reauthentication browser. Credentials and MFA are completed by the person in
that browser, never collected or replayed by Rico. Monitoring and authorized
context reads remain blocked until the adapter proves the dedicated profile is
ready again.

`View AI insights` is **not** a read-only action: clicking it can start summary
generation and a later notification. This workflow never clicks it and requires
`triggerAIInsightsGeneration: false`, `aiInsightGenerationAttempted: false`, and
`sideEffectsPerformed: false`. An insight that already exists may be read only
through the reviewed read-only interface. Generating one requires a separate
action-time confirmation and is outside this workflow.

## Bounded research and Polar collaboration

For one new incident fingerprint, the workflow places one internal research
handoff in the durable ledger. The handoff can allow the operator knowledge base
and public internet. Public results may cite only websites, legal cases,
magazine articles, newspaper articles, and books.

`grokbot:polar` is optional. When enabled it receives only the sanitized
research question, never raw chat content. The adapter must attest that neither
Polar nor any imported skill receives authority to:

- send an iMessage or email;
- read or export credentials;
- change security or configuration;
- schedule actions; or
- name the private source.

The module does not load arbitrary bot skills. A future Skills UI must map an
imported skill to a reviewed, named adapter capability and satisfy the same
proofs; a skill manifest or bot identity alone grants no authority.

## Private grant

Production activation requires the scoped v2 grant. It binds Alan, Jeff, the
immutable incident source group, optional normal Rico query groups, and the
explicit any-local-group authority. `incidentQueryGroups` may be empty only
when `anyLocalGroup` is true; those entries govern normal Rico prompt context,
not the separate deterministic ingress. A v1 grant remains readable only for
legacy compatibility and cannot be activated by the reviewed installer.

Create the activation request outside shell history. This illustrative shape
uses placeholders only; do not save a populated copy in the repository:

```json
{
  "schema": "rico.ists-incident-activation-request",
  "schemaVersion": 1,
  "permissionGrant": {
    "schema": "rico.ists-incident-grant",
    "schemaVersion": 2,
    "issuedAt": "2026-08-15T12:00:00.000Z",
    "incidentChat": {
      "chatId": "EXACT_IMMUTABLE_INCIDENT_CHAT_ID",
      "participantRevision": "sha256:EXACT_PARTICIPANT_SNAPSHOT_SHA256",
      "participants": [
        { "kind": "phone", "handle": "+1EXACT_OWNER" },
        { "kind": "phone", "handle": "+1EXACT_JEFF" }
      ],
      "participantSnapshotSha256": "EXACT_PARTICIPANT_SNAPSHOT_SHA256"
    },
    "owner": {
      "profileId": "EXACT_ALAN_PROFILE_ID",
      "principal": { "kind": "phone", "handle": "+1EXACT_OWNER" }
    },
    "incidentQueryGroups": [],
    "jeff": {
      "profileId": "EXACT_JEFF_PROFILE_ID",
      "principal": { "kind": "phone", "handle": "+1EXACT_JEFF" }
    },
    "imessage": {
      "sourceAccount": "EXACT_MESSAGES_SOURCE_ACCOUNT",
      "recipientGuardContract": "rico-recipient-guard/v6",
      "anyLocalGroup": true
    },
    "monitor": { "sameIncidentCooldownSeconds": 900 },
    "sen": { "enabled": false },
    "colleagueZone": { "enabled": false },
    "research": {
      "enabled": true,
      "publicInternet": true,
      "knowledgeBase": true,
      "polar": { "enabled": true, "collaboratorId": "grokbot:polar" }
    }
  },
  "colleagueZoneAdapterModule": null
}
```

Install disabled, inspect status, and only then enable. Grant data is accepted
on stdin and is never placed in a command argument:

```bash
node scripts/ists-incident.mjs install --stdin-json < /private/path/activation-request.json
node scripts/ists-incident.mjs status
node scripts/ists-incident.mjs enable --restart-gateway
```

For SEN enrichment, replace the one-field `sen` object with:

```json
{
  "enabled": true,
  "mailboxId": "EXACT_MAILBOX_ADDRESS",
  "profileId": "EXACT_REVIEWED_OUTLOOK_PROFILE_ID"
}
```

For Colleague Zone read-only status, replace its one-field object only after the
separate dedicated-profile adapter is reviewed and its browser runtime is ready:

```json
{
  "enabled": true,
  "sourceId": "cvs-colleague-zone:service-status",
  "pageUrl": "https://colleaguezone.cvs.com/cz?id=services_status",
  "profileId": "EXACT_REVIEWED_COLLEAGUE_ZONE_SESSION_PROFILE"
}
```

The bundled activation installer privately copies and selects the reviewed
adapter; `colleagueZoneAdapterModule` in the activation request therefore stays
`null`. If status reports `reauth-required`, complete sign-in and MFA only in
the dedicated visible browser:

```bash
node colleague-zone-adapter/scripts/reauth.mjs
```

## Reviewed adapter contract

The absolute adapter module exports:

```js
export async function createISTSIncidentAdapter(context) {
  return {
    async preflight(request) {},
    async pollIncidentMessages(request) {},
    async readIncidentContext(request) {},
    async summarizeIncident(request) {},
    async pollActiveSENNotifications(request) {},
    async sendReviewedIMessage(request) {},
    async enqueueResearchHandoff(request) {},
  };
}
```

When Colleague Zone is enabled, a different absolute mode-`0600` module exports:

```js
export async function createColleagueZoneStatusAdapter(context) {
  return {
    async preflight(request) {},
    async readActiveServiceStatus(request) {},
  };
}
```

It is configured separately as `colleagueZoneAdapterModule`; using the main
adapter path for both roles is rejected.

When `anyLocalGroup` is authorized, a third distinct mode-`0600` module exports:

```js
export async function createISTSAnyLocalGroupAdapter(context) {
  return {
    async preflightAnyLocalGroups(request) {},
    async listLocalIMessageGroups(request) {},
    async readLocalGroupMessages(request) {},
    async proveRecipientGuardExclusion(request) {},
    async sendSameGroupIncidentReply(request) {},
  };
}
```

It is configured only as `anyGroupAdapterModule`, and `anyGroupEnabled` can run
this scanner even when the main monitor or Colleague Zone source is disabled or
unavailable. Reusing the main or Colleague Zone adapter path is rejected.

The scanner accepts only a bounded, leading `@rico` current-status question. It
marks messages older than ten minutes (or more than two minutes in the future)
seen without research or reply. Every group currently managed by Recipient
Guard is excluded, including admitted, blocked, auto-reply-disabled, and
membership-drifted rows; a global Recipient Guard pause also blocks the scanner.
That policy and the exact live owner/sender/group membership are re-read before
research, after the bounded wait, and immediately before delivery.

For an eligible unmanaged group, the private signed handoff receives only the
exact visible message plus fixed host-authored fields under the narrow
`authorized_any_local_group` audience. Durable state outside that private inbox
stores hashes and scope only. The wait is capped at 90 seconds. A current claim
requires the structured `imt-current-status/v1` result, a fresh observation (ten
minutes maximum), and safe public HTTPS citations; otherwise Rico sends the
fixed neutral response and does not guess. The adapter writes its private
delivery reservation before sending, binds the reply to the same exact iMessage
group, disables SMS fallback, applies durable global/per-group limits, and
requires a transport acknowledgement.

All request and proof objects use closed schemas in `contracts.mjs`. Notable
requirements are:

- reads echo the exact chat ID, revision, complete snapshot/hash, and proof that
  agent-authored events were excluded;
- summaries echo the input digest and attest that no embedded instruction ran
  and no private source was named;
- sends accept no free-text destination, require the configured exact Jeff
  profile/principal, disable group expansion and SMS fallback, reuse existing
  per-sender/global rate limits, and return a delivered acknowledgement;
- research handoffs return no outbound, credential, security, configuration, or
  scheduling authority; and
- an enabled SEN source must echo the exact mailbox/profile and return only
  active, reviewed safe summaries;
- Colleague Zone must prove read-only authenticated access through one dedicated
  Playwright persistent profile, no cookie/storage/password/OTP inspection or
  export, mutation-request blocking, no side effects, and AI Insights generation
  disabled.

## Offline QA

The tests use fictional principals, temporary private directories, and fake
adapters. They do not read Messages, Contacts, Outlook, the internet, or Grok,
and they do not send anything.

```bash
npm run check
npm test
```
