#!/usr/bin/env bash
# Cloud Agent environment bootstrap for OpenClaw Studio.
#
# The shipping product (OpenClawStudio) is a native macOS SwiftUI/AppKit app and
# cannot build or run on the Linux Cloud Agent host. What this repository *can*
# exercise on Linux is its large suite of Node.js workspaces: OpenClaw plugins,
# governed MCP servers, and workflow runtimes. This script prepares a Node
# toolchain that satisfies every package's declared engine and installs the only
# two workspaces that carry third-party npm dependencies.
#
# The script is idempotent: it can be re-run safely against cached state.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Highest Node engine required across the workspaces is >=22.22.3
# (RicoEscalationHandoff). Install a satisfying Node 22 via nvm when the current
# interpreter is older, then use it for the rest of setup.
REQUIRED_NODE_MAJOR=22
REQUIRED_NODE_MINOR=22
REQUIRED_NODE_PATCH=3

node_is_new_enough() {
  command -v node >/dev/null 2>&1 || return 1
  node - "$REQUIRED_NODE_MAJOR" "$REQUIRED_NODE_MINOR" "$REQUIRED_NODE_PATCH" <<'NODE'
const [maj, min, pat] = process.argv.slice(1).map(Number);
const [a, b, c] = process.versions.node.split('.').map(Number);
const ok = a > maj || (a === maj && (b > min || (b === min && c >= pat)));
process.exit(ok ? 0 : 1);
NODE
}

if ! node_is_new_enough; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  if command -v nvm >/dev/null 2>&1; then
    nvm install 22 --latest-npm
    nvm use 22 >/dev/null
    nvm alias default 22 >/dev/null || true
    export PATH="$(dirname "$(nvm which 22)"):$PATH"
  fi
fi

echo "Using node $(node --version) / npm $(npm --version)"

# Playwright ships as a dependency of two workspaces, but the Cloud Agent host is
# headless and the browser binaries are only needed for live capture (which is
# fail-closed here). Skip the multi-hundred-MB browser download during install.
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Only these two workspaces have third-party npm dependencies; every other
# package relies solely on the Node standard library (node --test / node --check).
for pkg in workers/grok-companions ISTSIncidentWorkflow; do
  echo "==> npm install ($pkg)"
  ( cd "$pkg" && npm install --no-audit --no-fund )
done

echo "Cloud Agent environment bootstrap complete."
