# Deployment and rollback

Launch service:

- label: `ai.polar.rico-comms-monitor`
- plist: `/Users/alan/Library/LaunchAgents/ai.polar.rico-comms-monitor.plist`
- interval: 60 seconds plus RunAtLoad
- runner: `runner-81ee1217a9f64cf8ec15ae0bc8e86a11bd9f8c7195254f8d88b89334812ecc45.mjs`

Pinned inputs:

- `monitor.js`: `81ee1217a9f64cf8ec15ae0bc8e86a11bd9f8c7195254f8d88b89334812ecc45`
- `read-only.sb`: `f6ed62e012f8900777948691e582777adce5daf6c78b07006668c6e0e8a7befb`

The runner takes no arguments, verifies both hashes, and launches the monitor
inside the fixed sandbox. The sandbox denies writes to OpenClaw, Studio, Grok,
Codex, application, and launch-service state and denies shell, launchctl,
AppleScript, `open`, and Keychain execution. The monitor source permits only
three exact read-only OpenClaw commands.

The pre-timing-fix source and plist are owner-private under
`rollback-20260815T2118/`; the source hash is
`eac9a3dd9bf282ee627198f20a151d35203beb529ccd3cf53fede43f26bddd4b`.
Rollback is owner-only: boot out only
`gui/501/ai.polar.rico-comms-monitor`, restore those two exact snapshots, and
load that plist. Do not alter the gateway, iMessage channel, SIP, OpenClaw
autonomy, or any other routine. Re-enable only after `npm run check && npm
test`, hash verification, `plutil -lint`, one foreground read-only run, and a
fresh state receipt.

The legacy Grok routine `Rico Communications down watch` is not part of this
service and must not share the state files. Disable that exact routine through
Grok's supported routine UI when it is operable; do not edit transcript blobs,
opaque databases, global autonomy, or any other routine to achieve that.
