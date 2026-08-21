#!/bin/sh
# Activate the Notion CVS Health Mail + iCal MCP on this Mac.
# Does not print bearer tokens. Does not Funnel Gateway 18789.
set -eu
cd "$(dirname "$0")"

if [ ! -x /opt/homebrew/bin/node ]; then
  echo "activate-notion-mcp: node is required at /opt/homebrew/bin/node" >&2
  exit 1
fi

/opt/homebrew/bin/node index.mjs --init-token >/dev/null

if [ -x ./funnel-public.sh ]; then
  ./funnel-public.sh
fi

uid="$(id -u)"
launchctl kickstart -k "gui/${uid}/ai.polar.rico-imessage-mcp"

echo "Notion MCP local: http://127.0.0.1:18792/mcp"
echo "Notion MCP public: https://rico.tail434bbe.ts.net/notion-mcp/mcp"
echo "Token file path only: ${HOME}/Library/Application Support/OpenClaw Studio/secrets/rico-notion-mcp.token"
if command -v tailscale >/dev/null 2>&1; then
  tailscale funnel status || true
fi
