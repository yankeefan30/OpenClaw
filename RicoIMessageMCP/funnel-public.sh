#!/bin/sh
# Path-only Tailscale Funnel for Polar / Notion / other public HTTPS MCP clients.
# Leaves SMS Funnel /webhooks/sms on 443. Does not Funnel Gateway 18789.
set -eu
tailscale funnel --bg --yes --https=443 --set-path=/rico-mcp http://127.0.0.1:18791
# Distinct local port so prefix-stripped Funnel requests cannot reach iMessage send.
exec tailscale funnel --bg --yes --https=443 --set-path=/notion-mcp http://127.0.0.1:18792
