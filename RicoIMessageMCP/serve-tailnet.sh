#!/bin/sh
# Path-only Tailscale Serve for the loopback Rico iMessage MCP.
# Uses HTTPS 8444 so Funnel :443 /webhooks/sms and /rico-mcp stay on 443.
# Does not publish Gateway 18789. Polar's public path is funnel-public.sh.
set -eu
exec tailscale serve --bg --https=8444 http://127.0.0.1:18791
