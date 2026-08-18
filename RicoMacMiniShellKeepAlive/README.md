# Rico Mac mini shell keep-alive

Owner-reviewed LaunchAgent that keeps Rico's Mac mini exec/shell host awake
and recovers the existing OpenClaw node service if it goes stale.

It is a one-shot health/recovery job every 180 seconds, not a busy keepalive
loop. `StartInterval = 180` plus an overlapping `caffeinate -s -t 360`
assertion prevents idle sleep on AC power. If `ai.openclaw.node` is already
installed and last-seen is stale or the service is stopped, the helper runs
exactly `openclaw node restart --json`. It never installs a second node
identity, never touches the Gateway, iMessage, SIP, cron, or config, and
never sends a message.

The helper is inactive until an operator copies the bundled plist and loads
it. See `DEPLOYMENT.md`.

## Exact commands

- `/usr/bin/caffeinate -s -t 360`
- `/opt/homebrew/bin/openclaw node status --json`
- `/opt/homebrew/bin/openclaw node restart --json` only when the node service
  is already installed and unhealthy

## Private state

All state lives under `/Users/alan/Documents/Codex/rico-mac-mini-shell-keepalive`
with directory `0700` and `state.json` at `0600`. The receipt stores only
writer, timestamps, sleep/node status, a kickstart boolean, and reason codes.
Stdout, tokens, hostnames, and session identifiers are discarded.

## Verification

```sh
npm run check
npm test
plutil -lint launchd/ai.polar.rico-mac-mini-shell-keepalive.plist
```
