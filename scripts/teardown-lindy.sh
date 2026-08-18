#!/bin/sh
# Tear down Lindy connections on original Rico.local only.
# Leaves iMessage MCP, SMS Funnel /webhooks/sms, /rico-mcp, and Gateway 18789 alone.
set -eu

hostname_value=$(printf '%s' "${RICO_TEARDOWN_HOSTNAME:-$(hostname)}" | tr '[:upper:]' '[:lower:]' | sed 's/\.$//')
case "$hostname_value" in
  rico|rico.local) ;;
  *)
    echo "teardown-lindy: refuse host $hostname_value (original Rico.local only)" >&2
    exit 2
    ;;
esac

uid=$(id -u)
label="ai.polar.rico-lindy-bridge"
plist="$HOME/Library/LaunchAgents/${label}.plist"
support="$HOME/Library/Application Support/OpenClaw Studio"
token="$support/secrets/rico-lindy-bridge.token"
allowlist="$support/lindy-local-bridge.allowlist.json"

if [ "${RICO_TEARDOWN_LINDY_DRY_RUN:-}" = "1" ]; then
  echo "teardown-lindy: dry-run on $hostname_value"
  echo "would bootout gui/${uid}/${label}"
  echo "would remove $plist"
  echo "would remove $token"
  echo "would remove $allowlist"
  echo "would tailscale funnel --yes --https=443 --set-path=/lindy off"
  echo "would tailscale serve --yes --https=8445 off"
  exit 0
fi

if launchctl print "gui/${uid}/${label}" >/dev/null 2>&1; then
  launchctl bootout "gui/${uid}/${label}" || true
fi
if [ -e "$plist" ]; then
  rm -f "$plist"
fi
if [ -e "$token" ]; then
  rm -f "$token"
fi
if [ -e "$allowlist" ]; then
  rm -f "$allowlist"
fi

# Path-only. Do not omit --set-path (that would drop every Funnel on 443).
# Do not reset Funnel or Serve, and do not disable port 443 as a whole.
if command -v tailscale >/dev/null 2>&1; then
  tailscale funnel --yes --https=443 --set-path=/lindy off || true
  tailscale serve --yes --https=8445 off || true
fi

echo "teardown-lindy: Lindy local bridge, /lindy Funnel, and 8445 Serve are down on $hostname_value"
