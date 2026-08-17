#!/bin/sh
# Polar-flip only. Path-only Tailscale Funnel so Lindy cloud can reach
# HTTPS /lindy/mcp with the local bearer. Run this on Rico.local after
# Polar decides to publish. Do not install as always-on.
# Leaves /webhooks/sms and /rico-mcp alone. Does not Funnel Gateway 18789.
# Does not bind the LAN or a raw public interface.
set -eu
exec tailscale funnel --bg --yes --https=443 --set-path=/lindy http://127.0.0.1:18792
