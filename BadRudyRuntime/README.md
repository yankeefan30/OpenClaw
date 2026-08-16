# Bad Rudy governed runtime

This directory is the isolated orchestration, delivery, scheduling, and
rollback boundary for OpenClaw Studio's **Bad Rudy** tab. It does not install a
LaunchAgent, change OpenClaw configuration, read live messages, call Grok, or
send an iMessage by itself.

## Current availability

The runtime requires the bounded worker to report this exact capability:

```text
capabilities["grok:companions:bad-rudy"] === true
```

That capability is currently false because the worker cannot verify a Grok
web flow containing both visible labels `Companions` and `Bad Rudy`. The tab
must therefore show **Playwright: Down** and keep Capture disabled today. A
generic xAI image/video API is not an acceptable substitute. This is an
intentional fail-closed state, not a setup bypass.

## UI integration contract

Construct `BadRudyRuntime` with five adapters:

- `credentialProvider`: `MacOSGrokCredentialProvider`. It reads only Keychain
  service `openclaw-grok`, account `alan`. There is no environment or paste-in
  fallback.
- `worker`: `StdioPlaywrightWorkerClient` pointed at
  `workers/grok-companions/index.ts`. Its protocol is capture-only and never
  receives recipient or delivery information.
- `promptFilter`: the existing OpenClaw prompt-injection rule. Its
  `evaluate(prompt, context)` result must include `allow: true` and a nonempty
  `policyVersion`; the runtime binds the approval to the exact prompt SHA-256.
- `reviewedDelivery`: `ReviewedRicoAttachmentAdapter` connected to the
  loopback Gateway client.
- `rateLimitAuthority`: the live Rico policy authority. `health()`,
  `reserve(request)`, and `authorizeRecipient(request)` must bind every
  approval to a nonempty `policyVersion` and `revision`.
  `authorizeRecipient` is re-run for capture, initial confirmation, and
  scheduled-fire confirmation and must return the exact normalized recipient.
  Missing or revoked authority blocks the operation without consuming its
  confirmation. Bad Rudy's config allowlist can narrow this live decision but
  can never grant a recipient on its own. The local limiter is an additional
  ceiling only.
- `now`: injectable clock; production uses `() => new Date()`.

The Swift bridge should expose only these runtime operations:

| UI action | Runtime call | Important result |
| --- | --- | --- |
| Refresh status | `status()` | `keychain`, `worker`, `dryRun`, `killSwitch`, `captureReady`, `reasons` |
| Capture | `capture(request)` | normalized `CapturedClip`, or a confirmation card |
| Confirm Rico / queue | `confirmInitial({ confirmationId, confirmedBy: "human:studio" })` | confirmed send receipt or durable schedule |
| Scheduler wake | `tickScheduler()` | confirmation cards only; **never sends** |
| Confirm due schedule | `confirmScheduledFire({ confirmationId, confirmedBy: "human:studio" })` | confirmed send receipt |
| Recent list | `recentCaptures(20)`, `recentEvents(20)` | local metadata for Play / Reveal |

`capture(request)` accepts:

```js
{
  source: "human:studio",
  prompt: "...",                    // hard cap 2,000; soft cap handled by UI
  delivery: "workflow" | "rico" | "scheduler",
  recipient: "+1...",               // required for rico/scheduler; allowlist only
  scheduledAt: "2026-08-16T09:30:00-04:00", // scheduler only
  caption: "",                       // optional, reviewed by shared prompt rule
  advanced: {
    format: "mp4",
    maxDurationSeconds: 20,
    exportStill: true,
    retries: 1
  }
}
```

The UI must render `confirmation.display` before enabling **Confirm send**. It
contains recipient, channel, filename, byte size, duration, thumbnail path, and
scheduled time. A capture made while dry-run is on produces `would_send` and
never produces a confirmation that can later be upgraded to a real send.

## Reviewed Rico attachment boundary

Real delivery is accepted only when the loopback Gateway verifies:

```text
method: rico.imessage.sendReviewedAttachment
status: rico.imessage.attachmentStatus
contractVersion: rico-reviewed-attachment/v1
enforcement.verified: true
```

The adapter deliberately refuses the generic Gateway `send` method. The
reviewed call binds the allowlisted recipient, local path, MIME type, SHA-256,
byte size, clip ID, confirmation ID/purpose, and idempotency key. A missing or
ambiguous receipt is logged as `delivery.unknown`; it is never retried
automatically. The Gateway method still needs to be implemented and tested by
the existing Rico guard owner—until then Rico and Scheduler capture choices
remain disabled.

## Scheduler posture

- Input is America/New_York with an explicit `-04:00` or `-05:00` offset.
- Bounds are `now + 2 minutes` through `now + 30 days`.
- First confirmation creates the durable local job.
- Becoming due changes the job to `awaiting_fire_confirmation` and creates a
  second confirmation card.
- No LaunchAgent tick sends. Only a new human Studio click can call
  `confirmScheduledFire`.
- Keychain, kill switch, allowlist, exact worker capability, reviewed delivery
  health, live Rico recipient authority (including policy version/revision),
  and file fingerprints are all checked again before dispatch.

## Storage and privacy

Capture media lives only at:

```text
~/OpenClaw/artifacts/bad-rudy/YYYY-MM-DD/<uuid>.mp4
~/OpenClaw/artifacts/bad-rudy/YYYY-MM-DD/<uuid>.jpg
```

Runtime state and the JSONL event spool live under
`~/OpenClaw/artifacts/bad-rudy/_state/`, with directories at `0700` and files at
`0600`. Credential-shaped event fields are rejected. The worker's mandated
persistent browser profile is the one explicit non-artifact state path:
`~/OpenClaw/state/grok-profile`; it must never be used by the iMessage listener.
There is no HTTP server or cloud upload surface in this runtime.

## Offline installation and status

The production installer resolves its sources only from its own signed app
Resources directory. It copies a hardcoded allowlist of runtime and worker
files into these exact private paths:

```text
~/Library/Application Support/OpenClaw Studio/modules/bad-rudy
~/OpenClaw/workers/grok-companions
```

It creates the Swift feature-registry marker at:

```text
~/Library/Application Support/OpenClaw Studio/modules/bad-rudy/feature.json
```

with exactly:

```json
{"schema":"openclaw.bad-rudy-feature/v1","schemaVersion":1,"_ownedBy":"openclaw-studio:bad-rudy"}
```

It materializes fail-closed state only when absent, writes an exact owned-path
manifest, and makes recoverable timestamped backups before replacing existing
owned code. It installs no LaunchAgent and never reads or changes
`~/.openclaw/openclaw.json`.

Install from a packaged app:

```sh
/opt/homebrew/opt/node/bin/node "/Applications/OpenClaw Studio.app/Contents/Resources/BadRudyRuntime/scripts/bad-rudy.mjs" --install-bad-rudy
```

Read status from the installed module:

```sh
/opt/homebrew/opt/node/bin/node "/Users/alan/Library/Application Support/OpenClaw Studio/modules/bad-rudy/scripts/bad-rudy.mjs" --status
```

`--status` is read-only. It may probe the fixed Keychain item and bounded
worker, but it makes no directory, config, Gateway, browser, or network change.
Because a CLI invocation cannot possess the signed Studio prompt filter, live
Rico recipient/rate authority, or reviewed delivery adapter, it always reports
`captureReady: false` and `deliveryReady: false`; it never fakes those seams.

## Configuration and rollback

A missing configuration is `killSwitch: true`, `dryRun: true`, and an empty
allowlist. `BadRudyConfigStore.write` creates a timestamped backup before every
replacement. The shipped installer records no OpenClaw config key and no
LaunchAgent. Rollback refuses broad paths, symlinks, wrong owners, and unrelated
state. It moves only the manifest-owned module, worker, and `_state` directory
to Trash so recovery remains possible. Dated capture artifacts are preserved;
removing the module also removes `feature.json`, so the Swift registry hides
the tab.

Preview:

```sh
/opt/homebrew/opt/node/bin/node "/Users/alan/Library/Application Support/OpenClaw Studio/modules/bad-rudy/scripts/bad-rudy.mjs" --rollback-bad-rudy --dry-run
```

Execute the requested rollback:

```sh
/opt/homebrew/opt/node/bin/node "/Users/alan/Library/Application Support/OpenClaw Studio/modules/bad-rudy/scripts/bad-rudy.mjs" --rollback-bad-rudy
```

## Offline verification

```sh
cd /Users/alan/OpenClawStudio/BadRudyRuntime
npm test
```

The tests use fake workers, Keychain providers, Gateway clients, media, and
clocks. They make no Grok call, launch no browser, modify no live config or
LaunchAgent, and send no iMessage.
