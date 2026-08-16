# Rico communications monitor

This is the single headless availability collector for Rico's iMessage channel.
It runs independently of Grok Bot, Codex, Studio, and the desktop lock state.

The collector can execute only three frozen OpenClaw commands:

- `gateway health --json --timeout 20000`
- `channels status --probe --channel imessage --json --timeout 20000`
- `gateway stability --json --limit 25 --timeout 20000`

There is no command path for configuration changes, service restarts, channel
sends, Studio control, plugin installation, or model-policy changes. Raw command
stderr, account identifiers, recipients, session identifiers, and credentials
are never persisted.

`state.json` is the current truth and has a 150-second freshness deadline.
Control-plane state and delivery state are independent. An iMessage channel is
DOWN only after three consecutive direct failures. After a confirmed UP, the
two-sample debounce window retains that last-known UP state while recording
`direct_probe_ok: false`, the reason codes, and the exact failure count. A cold
start remains UNKNOWN until a direct success. A recent delivery error is
pageable only after two observations and a matching failed outbound queue. SIP
being enabled and the private API being unavailable are expected and do not
make the channel DOWN.

All state lives under `/Users/alan/Documents/Codex/rico-comms-monitor`, with the
directory at `0700` and files at `0600`. `LATEST-DOWN.md` exists only while the
control plane is actually DOWN; two successful recovery samples archive it
under `incidents/`. A timeout or partial recovery cannot clear it.
`ALERT.json` is a local, unsent page request. This monitor never sends a message.

Run offline QA with `npm run check && npm test`.
