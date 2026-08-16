#!/bin/sh
# Path-only Tailscale Funnel for Polar / other public HTTPS MCP clients.
# Leaves SMS Funnel /webhooks/sms on 443. Does not Funnel Gateway 18789.
set -eu
exec tailscale funnel --bg --yes --https=443 --set-path=/rico-mcp http://127.0.0.1:18791
