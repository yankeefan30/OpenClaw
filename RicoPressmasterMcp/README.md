# Rico Pressmaster MCP

Rico-local MCP so Polar (Grok Bot on **original Rico only**) can draft and publish through Alan's Pressmaster workspace without using Pressmaster's hosted OAuth connector.

The hosted remote MCP at `https://app.pressmaster.ai/mcp` is real. Grok Bot / Cursor cannot complete its OAuth: Pressmaster rejects `redirect_uri did not match any of the client's registered redirect_uris`. This package does **not** fix that hosted client. It registers its own public PKCE client with a **loopback** redirect on Rico, stores the bearer in macOS Keychain, and talks to the same official Streamable HTTP MCP.

Do not install or run this on Rico 2.

## Investigation (2026-08-19)

Live surface, not a guessed API:

| Probe | Result |
| --- | --- |
| `GET/POST https://app.pressmaster.ai/mcp` | `401` `{"error":"missing_bearer"}` plus `WWW-Authenticate: Bearer resource_metadata="https://app.pressmaster.ai/.well-known/oauth-protected-resource/mcp", scope="mcp"` |
| Protected-resource metadata | `resource=https://app.pressmaster.ai/mcp`, `authorization_servers=["https://app.pressmaster.ai/oauth/mcp"]`, bearer in header only |
| Authorization-server metadata | `authorization_code` + `refresh_token`, PKCE `S256`, scopes `openid offline_access mcp`, DCR at `/oauth/mcp/reg` |
| `POST /oauth/mcp/reg` | `201` for a public client (`token_endpoint_auth_method=none`) with `http://127.0.0.1:<port>/oauth/callback` |
| [Official docs](https://docs.pressmaster.ai/integrations/mcp.md) | “You don't need an API key. Authentication runs through OAuth in your browser.” MCP URL is `https://app.pressmaster.ai/mcp` |
| Public REST/GraphQL | Not documented. Marketing FAQ still says API access is a future Agency/Enterprise rollout. `https://api.pressmaster.ai` wants HTTP Basic and is not a documented content API |
| Browser session cookies | Not used. Not a design path |

Official tools were **not** listed from this cloud agent (no Alan login, and cookies are out of scope). After `--login` on Rico, `tools/list` is proxied from Pressmaster and merged with the local wrappers. This server does not invent a Pressmaster REST API.

[Pressmaster social docs](https://docs.pressmaster.ai/integrations/social-media.md) say Pressmaster publishes **LinkedIn posts**, not LinkedIn-native **articles** (LinkedIn's API does not allow article publish). Long-form article drafts still live in the Pressmaster Content Library.

## Tools

Local wrappers Polar can call immediately after login. They forward to the official MCP tool that matches by name/description. If Pressmaster does not expose a match, the wrapper fails closed and lists the official tool names.

| Tool | Behavior |
| --- | --- |
| `rico_pressmaster_health` | Hostname, auth source, official MCP URL. Never publishes. |
| `rico_pressmaster_whoami` | Official `initialize` + discovered tool names. |
| `rico_pressmaster_list_drafts` | List Content Library drafts. |
| `rico_pressmaster_get_draft` | Get one draft. |
| `rico_pressmaster_create_or_update_draft` | Create/update a library draft (article / LinkedIn long-form). **Never publishes.** |
| `rico_pressmaster_list_channels` | Connected publish channels (confirm LinkedIn). |
| `rico_pressmaster_publish_or_schedule` | **Explicit** publish/schedule only. QA must pass `dryRun: true`. |
| `rico_pressmaster_twin_generate` | Twin / generate-from-brief if the official MCP exposes it. |

Create rejects `publish` / `schedule` arguments. `dryRun: true` on publish resolves the official tool and returns the intended call without sending it.

## Hostname gate

Every runtime entrypoint except `--help` and `--selftest` aborts unless this Mac is original Rico:

- `hostname` is `Rico.local` or `Rico`, **or**
- `scutil --get LocalHostName` is `Rico`

`Rico-2`, `Rico2`, `Rico-2.local`, and anything else fail closed. Do not install on Rico 2.

## Auth

1. On original Rico, run `--login`.
2. The process registers a **new** public OAuth client with Pressmaster (loopback `redirect_uri`), opens the official authorize URL, and waits on `127.0.0.1` only.
3. The access + refresh bundle is written to Keychain with `KeychainWriteHelper.swift` (secret on stdin, never argv or git):
   - service `rico-pressmaster-mcp`
   - account `alan`
4. Polar may instead inject `PRESSMASTER_ACCESS_TOKEN` (and optional `PRESSMASTER_REFRESH_TOKEN` + `PRESSMASTER_CLIENT_ID`) in the local MCP **env field**, never in chat.

Schema illustration only — do not put a real bundle in the repo:

```json
{
  "schema": "rico.pressmaster.oauth-bundle",
  "version": 1,
  "issuer": "https://app.pressmaster.ai/oauth/mcp",
  "resource": "https://app.pressmaster.ai/mcp",
  "clientId": "<DCR client id>",
  "tokenEndpointAuthMethod": "none",
  "accessToken": "<redacted>",
  "refreshToken": "<redacted>",
  "tokenType": "Bearer",
  "scope": "openid offline_access mcp",
  "expiresAt": "2026-08-19T15:00:00.000Z"
}
```

## Polar landing (original Rico only)

Copy this folder to:

```text
/Users/alan/OpenClawStudio/RicoPressmasterMcp
```

Needs Homebrew Node (`/opt/homebrew/opt/node/bin/node`). No extra npm packages.

### 1. Login once (Alan, on Rico, in a browser)

```sh
cd /Users/alan/OpenClawStudio/RicoPressmasterMcp
/opt/homebrew/opt/node/bin/node index.mjs --login
```

Sign in as Alan and approve the workspace that already has LinkedIn connected. The command prints the authorize URL and the Keychain **service/account**, never the token.

### 2. Add the local MCP (Grok Bot on Rico)

Prefer stdio. In Polar / Grok Bot **AddMcpServer**:

| Field | Value |
| --- | --- |
| **Name** | `rico-pressmaster` |
| **Command** | `/opt/homebrew/opt/node/bin/node` |
| **Args** | `["/Users/alan/OpenClawStudio/RicoPressmasterMcp/index.mjs","--stdio"]` |
| **Env** | empty if Keychain login succeeded; otherwise `PRESSMASTER_ACCESS_TOKEN` in the secret env field only |

Optional loopback HTTP (same Mac only):

```sh
/opt/homebrew/opt/node/bin/node /Users/alan/OpenClawStudio/RicoPressmasterMcp/index.mjs
```

| Field | Value |
| --- | --- |
| **Name** | `rico-pressmaster` |
| **URL** | `http://127.0.0.1:18793/mcp` |

Do **not** Funnel this. Do **not** add `https://app.pressmaster.ai/mcp` as a Grok Bot catalog/OAuth connector. Do **not** load this on Rico 2.

Optional LaunchAgent (Rico only, after login):

```sh
cp /Users/alan/OpenClawStudio/RicoPressmasterMcp/launchd/ai.polar.rico-pressmaster-mcp.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/ai.polar.rico-pressmaster-mcp.plist
```

That plist starts the loopback HTTP listener. Stdio AddMcpServer does not need it.

### 3. QA Polar should run (no live LinkedIn)

1. `rico_pressmaster_health`
2. `rico_pressmaster_whoami` / `rico_pressmaster_list_channels` (confirm LinkedIn)
3. Draft create/list/get
4. If Polar must exercise publish: `rico_pressmaster_publish_or_schedule` with `dryRun: true` only

Do not send or publish to LinkedIn as part of landing QA.

## Uninstall

```sh
launchctl unload ~/Library/LaunchAgents/ai.polar.rico-pressmaster-mcp.plist 2>/dev/null || true
rm -f ~/Library/LaunchAgents/ai.polar.rico-pressmaster-mcp.plist
security delete-generic-password -s rico-pressmaster-mcp -a alan
```

Remove the `rico-pressmaster` server from Grok Bot / Polar AddMcpServer. Leave Pressmaster's hosted connector unused.

## Tests

```sh
cd /Users/alan/OpenClawStudio/RicoPressmasterMcp
npm test
node index.mjs --selftest
```

Tests mock Pressmaster. They do not call live publish. Hostname-gate tests cover Rico vs Rico 2. `--selftest` is the only network-free process entry that skips the host gate so CI can run.

## What this is not

- Not the hosted Grok Bot / Cursor Pressmaster OAuth connector
- Not a scraped browser session
- Not a fake Pressmaster REST/GraphQL client
- Not an OpenClaw Gateway, iMessage, Qwen, or Rico 2 change
- Not Lindy
