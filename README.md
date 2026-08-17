# OpenClaw Studio

Native macOS command center for a local OpenClaw installation.

## Build and run

```sh
cd ~/OpenClawStudio
swift test --disable-sandbox
scripts/package-app.sh
open "/Applications/OpenClaw Studio.app"
```

The packaged app uses the stable bundle identifier `ai.openclaw.studio`,
declares its Contacts purpose, and embeds the hardened-runtime Address Book
entitlement so macOS can grant Contacts to the actual app identity. Packaging starts from a clean
bundle on every build. It requires the pinned Apple Development identity (or
an explicitly supplied valid `SIGN_IDENTITY`) and refuses ad-hoc production
signing, keeping macOS privacy identity stable across installed builds.
The app also prohibits simultaneous GUI instances so a development bundle
cannot compete with the installed app for Rico's single policy-writer lease.
The exact matching Rico guard is bundled under the app's Resources directory
so deployment can install and verify the UI and Gateway boundary as one release.

## Missions

Missions are durable, reviewed autonomy contracts rather than free-form prompts.
The natural-language builder compiles an outcome into exact agent, session, job,
trigger, tool, and outbound selectors plus an enforced local-time window,
escalation rules, budgets, and evidence requirements. A new mission is always inactive. Studio shows the
exact contract and requires explicit review before sending it to the Gateway.

The bundled Rico Autonomy Governor is the enforcement boundary. It starts globally
paused, persists mission state and an append-only hash-chained event ledger with
private filesystem permissions, and enforces active mission authority before an
agent run, tool call, or outbound message. Shadow observes and records decisions;
Suggest prepares recommendations without unreviewed side effects; Bounded permits
only exact reviewed tools and recipients within run, tool-call, write, outbound,
and runtime ceilings plus the enforced local-time window.
There is no unbounded or “Trusted” execution mode.

Mission Control displays Gateway-verified enforcement health, mission state,
budgets, evidence, exceptions, and the authoritative event history. Activation and
resume are locked unless the Gateway reports a healthy matching enforcement
contract. Pause remains available as a restrictive action when health degrades.

The governor is an authority boundary, not a scheduler or planner runtime. A
Mission does not silently create a cron job, Workboard card, or TaskFlow. Reviewed
wakes are configured separately in Automations; independently verified completion
and managed TaskFlow supervision remain future work.

## Command center

Command is pinned to Rico's primary `agent:main:main` session. Requests use the
Gateway's `chat.send` idempotency contract and `agent.wait` terminal state;
Studio never silently switches to another conversation. Tasks, approvals,
sessions, Workboard, channels, agents, nodes, and models are read from the
installed Gateway, with reviewed mutations routed through their documented
RPCs and required operator scopes.

## Automations

The natural-language builder asks Rico for a strict `CronAddParams` proposal,
rejects unsupported output, and presents the schedule, timezone, action,
delivery, authority, and exact request for review. New jobs default to disabled
and are created only after a second explicit confirmation through
`openclaw cron add --json`. Existing jobs can be run, enabled, disabled, or
removed with visible `operator.admin` review.

## Rico communications

Contacts resolve display names to exact phone numbers or email addresses;
display names are never authentication. Individual and group policies are
stored privately and mirrored into OpenClaw's native iMessage allowlists. The
Rico guard fails closed for unknown senders, unknown group participants,
missing `@rico` mentions, disabled auto-replies, quiet hours, and emergency
pause. Owner-initiated sends require an explicit draft review and use an
atomic, single-use, two-minute grant containing a SHA-256 message digest rather
than message plaintext.

Messages sent from the Mac's own Apple identity are normally discarded by
OpenClaw as reflected `from me` traffic. The bundled owner-command route admits
only a leading `@rico` command from an exact configured owner handle in an exact
approved group. All near-misses pass through unchanged, and OpenClaw's native
group allowlist, dedupe, echo cache, mention gate, and Rico guard remain in the
path after that narrow normalization.

For Alan's exact direct self-chat, the same proxy binds a reply to the recent
authenticated chat row and sends by `chat_id` without a threaded-reply tag.
This avoids Messages' unreliable self-handle AppleScript lookup while leaving
every ordinary direct recipient and group target unchanged.

The app does not weaken SIP or macOS privacy controls. Messages database access
remains with the OpenClaw Gateway/imsg process that the user grants Full Disk
Access; Contacts access remains with the signed OpenClaw Studio app.

## MCP connections

MCP management uses the installed `openclaw mcp` CLI. Remote servers require
HTTPS outside loopback, TLS verification is not bypassed, credentials use
OAuth or environment references, and local stdio processes are launched with
argument arrays rather than a shell. Inventory reads suppress raw secrets;
network probes, mutations, OAuth changes, and Rico-mediated tool requests all
require review.

## Janet receipt workflow

The repo-owned `JanetReceiptWorkflow` package implements a single-handler,
exact-Janet receipt workflow. `Rico` and `Polar` are inbound invocation aliases,
not vendors. OpenCase requests use the OpenCase portal, Heygen requests use the
Heygen portal, and all other vendors use the exact fallback order Genius Scan,
Alan Gmail, then CVS Outlook. The workflow uses a private 0600
identity/recipient/capability grant, same-thread acknowledgement and close,
America/New_York time enforcement, PDF evidence verification, Alan Gmail's
fetched send-as signature, an at-most-one email reservation, private reports,
and a last-100 exact ledger backed by hash-chained replay evidence. It remains
inactive until an operator verifies the real adapter schemas; the repository
contains no production identities, recipients, credentials, or tokens.

## Outlook mail monitors

The bundled `OutlookMailMonitor` plugin defines two metadata-only, exact-scope
mail monitors on a fixed 90-second interval. Existing mail is baselined on first
activation; subsequent immutable message identities are durably deduplicated
before an exact private alert is attempted. The plugin is disabled by default
and requires a mode-0600 permission grant plus a reviewed adapter that proves
the exact Outlook mailbox/folder/sender and exact iMessage source/destination.
No user identity, alert copy, credential, subject, or message body is committed
to the app. See `OutlookMailMonitor/README.md` for its adapter contract and
deployment blocker.

## Bad Rudy

Bad Rudy is an optional, locally installed Studio module with a Keychain-only
Grok credential contract (`openclaw-grok` / `alan`), a bounded Playwright
capture worker, local MP4/JPEG artifacts, dry-run delivery, exact Rico
allowlist selection, and two-stage scheduler confirmation. Capture and delivery
are separate contracts: the browser worker never receives a recipient, channel,
or schedule, and a captured clip cannot recursively trigger another capture.

The module currently remains fail-closed with
`grok_companions_web_unavailable`. xAI does not expose a verified Grok
Companions → Bad Rudy web surface, so Studio does not substitute the generic
xAI video API or guess selectors. The tab can be installed for status and UI
review, but Capture stays disabled until the bounded worker proves both exact
visible labels and the reviewed Rico attachment Gateway contract exists.

Install and rollback use only signed, bundled resources. Rollback is
manifest-scoped, moves owned code and private runtime state to Trash, preserves
dated capture media, touches no unrelated OpenClaw state, and installs no
auto-send LaunchAgent.

## Lindy local mail/calendar bridge

Lindy is the only messaging front door. Rico on **Rico.local** is a thin local
bridge for CVS Health Outlook and Calendar.app — not a speaker and not a
general SMS agent. Lindy cannot call `127.0.0.1`; Polar publishes
`/lindy/mcp` over Tailscale. See [`RicoLindyBridge/README.md`](RicoLindyBridge/README.md).
Keep `channels.imessage.enabled` false. Do not apply this on Rico 2.

## Verification

```sh
swift test --disable-sandbox
(cd RicoLindyBridge && npm test)
(cd OpenClawPlugin && npm test)
node --test IMsgOwnerRoute/imsg-owner-route.test.mjs
(cd AutonomyGovernorPlugin && npm test && npm run check)
(cd RicoEmailGovernance && npm run check && npm test)
(cd RicoSkillsRuntime && npm test)
(cd ISTSIncidentWorkflow && npm run check && npm test)
(cd OpenTableMCP && npm test)
(cd UberMCP && npm test)
(cd MobilityDiningIntegration && npm test)
(cd JanetReceiptWorkflow && npm test)
(cd OutlookMailMonitor && npm test)
(cd BadRudyRuntime && npm test)
(cd workers/grok-companions && npm test && npm run typecheck && npm run selftest)
swift run --disable-sandbox OpenClawStudioFixtures
```

See [`docs/SECURITY.md`](docs/SECURITY.md) for the threat model.
