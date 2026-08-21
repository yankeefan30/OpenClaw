# AGENTS.md

## Cursor Cloud specific instructions

This repo is **OpenClaw Studio**: a native macOS SwiftUI app (`Sources/`, `Package.swift`)
plus ~17 self-contained Node.js packages (MCP servers, OpenClaw plugins, and workflow
runtimes). The Cloud Agent VM is **Linux**, so scope is split:

- **macOS Swift app (`OpenClawStudio`, `OpenClawStudioFixtures`, `swift test`, `scripts/package-app.sh`)**:
  cannot be built or run here. Swift is not installed and the app uses macOS-only frameworks
  (SwiftUI/AppKit/Contacts/EventKit). CI builds it on a `macos-14` runner (`.github/workflows/ci.yml`).
  Do not try to install Swift to build the app on Linux.
- **Node.js packages**: this is the runnable/testable scope on Linux. Node v22 is available.

### Node version gotcha
The default `node` on PATH is `/exec-daemon/node` = **v22.14** (npm/pnpm resolve to nvm's v22.22.2).
- Most packages only need Node >=20, so v22.14 is fine.
- `workers/grok-companions` requires Node **>=22.18** and TS type-stripping. Run it with nvm's node
  explicitly (PATH order puts 22.14 first): `/home/ubuntu/.nvm/versions/node/v22.22.2/bin/node`,
  e.g. `.../v22.22.2/bin/node --experimental-strip-types --test tests/*.test.ts`.

### Dependencies
Only `workers/grok-companions` has real deps (`playwright`, `typescript`, `@types/node`); the update
script installs them with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` (the worker is fail-closed and never
launches a browser here). All other packages are dependency-free and use Node's built-in test runner.

### Testing
Full verification suite is in `README.md` ("Verification"). Each Node package: `npm test` (a `node --test`
run) and some have `npm run check` (syntax `node --check`). No `npm install` needed except grok-companions.

**Expected environmental failures on Linux (NOT code bugs)** — these tests require a real macOS OpenClaw
runtime and fail closed here; they pass only on macOS with OpenClaw installed:
- `OpenClawPlugin`: 1 fail — expects a globally installed `openclaw` CLI at `/opt/homebrew/.../openclaw/dist`.
- `RicoEmailGovernance`: 7 fail — reads `/Applications/Microsoft Outlook.app` bundle plist (`native_outlook_plist_unavailable`).
- `ISTSIncidentWorkflow`: 20 fail — need the macOS iMessage transport (`imsg_unavailable`).
All other suites pass fully (e.g. `RicoIMessageMCP` 46/46, `grok-companions` 19/19).

### Running the RicoIMessageMCP server (the primary runnable app on Linux)
`RicoIMessageMCP` is a loopback streamable-HTTP MCP server (full profile `:18791`, Notion CVS Health
profile `:18792`). To start it here:
1. It reads `~/.openclaw/openclaw.json` at startup and requires a `gateway.auth.token`. On Linux the
   OpenClaw Gateway (`ws://127.0.0.1:18789`) is not running, so create a minimal placeholder once:
   `{"gateway":{"auth":{"token":"dev-local-placeholder-not-a-real-secret"}}}`. Without this file the
   process prints only "Rico iMessage MCP failed closed." (the real error is swallowed).
2. Point token files at a writable path to avoid the default macOS support dir:
   `RICO_IMESSAGE_MCP_TOKEN_FILE=/tmp/rico-mcp/imsg.token RICO_NOTION_MCP_TOKEN_FILE=/tmp/rico-mcp/notion.token node index.mjs`
   (`node index.mjs --init-token` creates the bearer files and prints only their paths).
3. What works without the Gateway/macOS: MCP `initialize`, `tools/list`, bearer auth (401 without token,
   per-port tokens), and the `rico_imessage_can_send` allowlist gate. Tools that hit the Gateway
   (`rico_imessage_send`) or AppleScript (`rico_mail_*`, `rico_calendar_*`, `rico_outlook_*`) fail closed
   here — that is expected, not a bug.
