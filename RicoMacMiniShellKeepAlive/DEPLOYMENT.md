# Deployment and rollback

Launch service:

- label: `ai.polar.rico-mac-mini-shell-keepalive`
- plist: `/Users/alan/Library/LaunchAgents/ai.polar.rico-mac-mini-shell-keepalive.plist`
- interval: 180 seconds plus RunAtLoad
- runner: `/opt/homebrew/bin/node /Users/alan/OpenClawStudio/RicoMacMiniShellKeepAlive/keepalive.mjs`

This service does not install `ai.openclaw.node`. If the Mac mini already
exposes shell/exec through OpenClaw.app's embedded node, leave that identity
alone and rely on the sleep assertion. Load a headless node host only when
one is already the reviewed shell target.

## Load

```sh
cd /Users/alan/OpenClawStudio/RicoMacMiniShellKeepAlive
npm run check && npm test
plutil -lint launchd/ai.polar.rico-mac-mini-shell-keepalive.plist
install -m 0644 launchd/ai.polar.rico-mac-mini-shell-keepalive.plist \
  /Users/alan/Library/LaunchAgents/ai.polar.rico-mac-mini-shell-keepalive.plist
launchctl bootout "gui/$(id -u)/ai.polar.rico-mac-mini-shell-keepalive" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" \
  /Users/alan/Library/LaunchAgents/ai.polar.rico-mac-mini-shell-keepalive.plist
launchctl kickstart -k "gui/$(id -u)/ai.polar.rico-mac-mini-shell-keepalive"
```

Confirm `state.json` is `0600` and shows `sleep_assertion: ok`. A
`node: missing` receipt is expected when no headless node service is
installed; that is not a license to run `openclaw node install`.

## Rollback

Owner-only: boot out only
`gui/$(id -u)/ai.polar.rico-mac-mini-shell-keepalive` and remove that plist.
Leave the Gateway, iMessage channel, SIP, OpenClaw autonomy, and
`ai.openclaw.node` unchanged.
