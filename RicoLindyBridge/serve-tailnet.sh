#!/bin/sh
# Tailnet-only Serve for Polar testing on Rico.local.
# Does not open a raw public port. Does not start Funnel.
# Does not publish Gateway 18789 or the iMessage MCP.
# Lindy cloud cannot join this tailnet — Polar must flip funnel-lindy.sh
# when Lindy Integrations → MCP needs a public HTTPS URL.
set -eu
exec tailscale serve --bg --https=8445 http://127.0.0.1:18792
