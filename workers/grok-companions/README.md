# Bad Rudy Grok Companions worker

This directory is the capture-only side of OpenClaw Studio's proposed **Bad
Rudy** feature. It has no iMessage, scheduler, workflow-dispatch, or cloud
upload code. Its only successful output contract is a local `CapturedClip`.

## Current capability state

The worker is intentionally **fail-closed** with
`grok_companions_web_unavailable`. xAI does not currently document a web
Companions / Bad Rudy surface. The generic xAI video API is not Bad Rudy and is
never used as a substitute.

An explicitly enabled runtime capability probe may navigate to Grok, but it
must observe exact, visible `Companions` and `Bad Rudy` labels before prompt
submission is possible. The accessibility probes live only in
`selectors.ts`. Missing or changed labels stop the run and save a failure
screenshot; they do not trigger guessed selectors.

The requested persistent authenticated profile conflicts with the stronger
credential rule: Chromium would persist Keychain-derived cookies or web
storage to disk. This worker therefore uses a Playwright incognito context and
keeps authentication state in memory. The declared
`~/OpenClaw/state/grok-profile` path is reserved but not written. Do not change
this to `launchPersistentContext` unless authenticated state is backed by a
verified memory-only filesystem.

## Security contract

- Keychain lookup is fixed to service `openclaw-grok`, account `alan`, through
  `/usr/bin/security`. There is no environment-variable or paste-in fallback.
- The Keychain item must be JSON containing a non-empty `cookies` array. Cookie
  domains are limited to Grok/xAI/X origins. An optional `origins` array can
  provide web storage for those same fixed origins. Values remain in worker
  memory and are never included in diagnostics or JSONL.
- A Keychain item containing an xAI API key returns
  `grok_bad_rudy_api_unavailable`; the worker does not silently change the
  requested product.
- The host's prompt-injection decision is bound to the exact prompt with
  `governance.promptApproval.sha256`. The worker also enforces the 2,000
  character cap and rejects control characters.
- Kill switch, an empty-allowlist gate, existing rate-limit denial, recursive
  `source="grok:bad-rudy"`, and duplicate prompt/minute all fail closed. The
  delivery governance layer owns recipient validation and the stricter
  prompt+recipient+minute dedupe key; no identity crosses into this worker.
- Browser automation is bounded by per-step timeouts and at most two retries.
  Playwright is dynamically loaded only after every preflight passes.
- `ffmpeg` and `ffprobe` must exist at a fixed trusted local path. Outputs are
  normalized to MP4, capped at 60 seconds (20 seconds by default), stripped of
  metadata, and created mode `0600`.
- Artifacts and redacted JSONL events live only under
  `~/OpenClaw/artifacts/bad-rudy/YYYY-MM-DD/`.
- Before every directory, log, screenshot, staging-media, thumbnail, or final
  file operation, the worker validates the complete parent chain with `lstat`
  and `realpath`. Existing symlinks, hard-linked files, foreign owners, wrong
  types, or non-private managed modes fail closed. New files use exclusive
  `O_NOFOLLOW` handles; ffmpeg uses no-overwrite mode.
- Dry-run still permits local capture by design, but the delivery adapter must
  emit `would_send`; this worker contains no send primitive.

## Host request contract

Runtime files are `index.ts`, `selectors.ts`, and `package.json`. The worker
requires Node 22.18 or newer with type stripping, the npm `playwright` package
and its Chromium binary, `/usr/bin/security`, plus `ffmpeg` and `ffprobe` at a
fixed trusted Homebrew/system path. Tests, `tsconfig.json`, and this README are
not needed by the packaged worker.

The supported CLI flags are:

- `--status`: reads `{killSwitch, dryRun, allowlistReady}` JSON from stdin and
  emits normalized health. Its capability map remains false unless the same
  bounded run has completed the explicit read-only label probe.
- `--capture`: reads the channel-neutral request below from stdin and emits one
  `CapturedClip` on stdout. Sanitized errors go to stderr.
- `--selftest`: takes no input, performs no Keychain/browser/network operation,
  and emits the offline QA report.

Send the request as JSON on stdin so prompts do not appear in the process list:

```sh
node --experimental-strip-types index.ts --capture < request.json
```

The production Studio host should pipe JSON directly; it should not create
`request.json`. The shape is exported as `CaptureRequest` from `index.ts`:

```ts
{
  prompt: string,
  source?: string,
  requiredCapability: "grok:companions:bad-rudy",
  advanced?: {
    format?: "mp4",
    maxDurationSeconds?: number, // 1...60, default 20
    exportStill?: boolean,       // default true
    retries?: number             // 0...2, default 1
  },
  governance: {
    killSwitch: boolean,
    dryRun: boolean,
    allowlistReady: boolean,
    rateLimitApproved: boolean,
    promptApproval: {
      approved: boolean,
      policyVersion: string,
      sha256: string
    },
    runtimeCapabilityProbe?: boolean
  }
}
```

`promptApproval.sha256` is lowercase SHA-256 of the exact UTF-8 prompt. The
worker receives only the boolean result of the allowlist gate. It has no
recipient, channel, schedule, or delivery fields.

## Output contract

The only success value is:

```ts
type CapturedClip = {
  id: string;
  path: string;
  mime: "video/mp4";
  duration_ms: number;
  thumbnail_path: string | null;
  prompt: string;
  created_at: string;
  source: "grok:bad-rudy";
};
```

Delivery adapters must consume this value after capture. They must separately
enforce dry-run, human confirmation, scheduler timing, attachment allowlisting,
and the existing Rico one-time authorization path.

## Offline QA

```sh
npm test
npm run selftest
```

`--selftest` is intentionally offline and reports `networkCalls: 0`. It checks
policy binding, dedupe binding, loop suppression, and redaction, then marks the
live runtime capture step skipped with
`grok_companions_web_unavailable`. It never reads Keychain, starts a browser,
or sends anything.

The offline regression suite additionally replaces the dated artifact
directory and an ancestor with symlinks and verifies that no outside file is
created. It also checks private directory modes, stale pre-submit video
rejection, and post-render fallback seek placement.

`--status` is a production diagnostic and does read the fixed Keychain item;
it returns only `ok`, `missing`, or `invalid`, never the value.
