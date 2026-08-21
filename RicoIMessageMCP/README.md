# Rico iMessage MCP

A **narrow loopback MCP server** so a tailnet client (for example a self-hosted [runner.now](https://guides.runner.now/connections/connect-your-own-mcp) job) can hit Rico’s OpenClaw instance without exposing the Gateway.

This is **not** `openclaw mcp serve`. That command exposes Gateway conversations, history, and approvals. This package wraps allowlisted iMessage `send`, a `channels.status` probe, an allowlist check that never calls `send`, and a small local-app surface for Mail.app, Calendar.app, and governed Microsoft Outlook on this Mac.

OpenTable MCP and Uber MCP stay disabled. SIP is unchanged. Twilio/A2P Funnel on `/webhooks/sms` is independent.

## What it is

| Tool | What it does |
| --- | --- |
| `rico_imessage_send` | Send to an **allowlisted** E.164 number or `chat_id:<id>` only. Strangers are rejected before Gateway `send`. Optional `idempotencyKey`. Start this on **Ask** in runner.now. |
| `rico_imessage_health` | Loopback OpenClaw Gateway reachability plus iMessage `probe.ok`. No tokens, account IDs, or raw status dumps. |
| `rico_imessage_can_send` | Allowlist check only. Does **not** send and does **not** call Gateway `send`. |
| `rico_local_apps_health` | Mail.app, Calendar.app, and Outlook reachable? Installed/configured only. No tokens or account IDs. |
| `rico_mail_list_accounts` | Apple Mail account names on this Mac. No mailbox contents. Extra email addresses are stripped before the tool result. |
| `rico_mail_list_inbox` | Bounded recent Apple Mail inbox metadata (default/max 15). Optional `account` selects one Mail.app account instead of the unified inbox. |
| `rico_mail_get` | One inbox message by id. Body truncated. Optional `account` scopes the lookup. |
| `rico_mail_send` | Send/reply from Mail.app **only** to an allowlisted address (person-email authorization, owner account, or recipient-guard email). |
| `rico_calendar_list_calendars` | Calendar.app (iCal) names, with account/source when EventKit can provide it. |
| `rico_calendar_list` | Upcoming Calendar.app events in a bounded window (default 7 days, max 14; max 25 events). Optional `calendar` and `account`. |
| `rico_calendar_upsert` | Create or update one local event on a named calendar. No attendees. |
| `rico_outlook_list_inbox` | Bounded recent Outlook inbox metadata. Clear error if Outlook is missing. |
| `rico_outlook_get` | One Outlook inbox message by id. Clear error if Outlook is missing. |
| `rico_outlook_send` | One governed Outlook send to a Rico-authorized person or owner account. Reuses Outlook-only person-email policy. Strangers rejected. |

Grokbot on this Mac should keep the server name **`rico-openclaw`** (stdio → `http://127.0.0.1:18791/mcp`). Remote Grokbot boxes must not AppleScript Mail themselves; this LaunchAgent is the local process.

Inbound iMessage → runner.now is **not built**. runner.now Custom MCP is an outbound HTTPS client (it calls your tools).

## Live bind and Serve URL

| Item | Value |
| --- | --- |
| Process | LaunchAgent `ai.polar.rico-imessage-mcp` (`KeepAlive`) |
| Bind | `127.0.0.1:18791` only (refuses `0.0.0.0` / LAN) |
| Local MCP | `http://127.0.0.1:18791/mcp` |
| Notion MCP | `http://127.0.0.1:18792/mcp` (CVS Health Mail + iCal profile) |
| Tailscale Serve | **port 8444 only** — `https://rico.tail434bbe.ts.net:8444/mcp` (tailnet) |
| Polar / public MCP | **path-only Funnel** — `https://rico.tail434bbe.ts.net/rico-mcp/mcp` |
| Notion / public MCP | **path-only Funnel** — `https://rico.tail434bbe.ts.net/notion-mcp/mcp` |
| Gateway | `ws://127.0.0.1:18789` — this process calls it locally and does not publish it |
| Token file | `~/Library/Application Support/OpenClaw Studio/secrets/rico-imessage-mcp.token` (`0600`) |
| Notion token file | `~/Library/Application Support/OpenClaw Studio/secrets/rico-notion-mcp.token` (`0600`) |

Serve on **8444** is tailnet-only. Polar’s remote Grok Bot box is not on this tailnet, so Polar uses path-only Funnel `/rico-mcp` on **443**. SMS Funnel `/webhooks/sms` stays. Do not Funnel Gateway `18789`. Do not Serve MCP as `/` on `443`.

## How to run

```sh
cd /Users/alan/OpenClawStudio/RicoIMessageMCP
node index.mjs --init-token    # prints the iMessage and Notion token *paths* only
node index.mjs                 # listens on :18791 (full) and :18792 (Notion CVS Health)
```

`--init-token` creates the bearer file if missing and prints **only the path**. The server never prints the token.

On this Mac the LaunchAgent starts the same `node index.mjs` at login. Foreground `node index.mjs` is only needed if the agent is unloaded.

## Auth

Shared bearer token, file-backed, never in git.

SecretRef shape (path only — do not put the token in `openclaw.json` or a session):

```json
{ "$file": "/Users/alan/Library/Application Support/OpenClaw Studio/secrets/rico-imessage-mcp.token" }
```

In runner.now: **Connected Apps → Custom MCP → Authentication → Bearer token**. Paste the token from that file into the **Bearer token** field, not into a chat.

The Gateway token is read from the existing local OpenClaw config (or its `$file` SecretRef) and is never logged.

## Allowlist

Send is denied unless **all** of these pass:

1. Target is E.164 or `chat_id:<id>` (email and other handles are rejected).
2. `rico-recipient-guard.json` has that identity as `approved`, `trusted`, or `owner` (and is not paused).
3. If `channels.imessage.allowFrom` is present, an E.164 must also be on that list.
4. If `channels.imessage.groups` is present, a `chat_id` must also be a reviewed group key.

Owner DMs (`+16469433060`) do **not** need `@rico`. iMessage **groups** still need `@rico` on inbound; this server does not change that Gateway/guard rule.

Mail send uses the same owner/approved people: Rico person-email authorizations, Alan’s approved Outlook sender accounts, or a recipient-guard identity whose target is already an email. Outlook send is stricter and stays on the existing Outlook-only governed path (person-email authorizations + approved sender accounts). Neither path will send to a stranger.

## macOS Automation prompts

The LaunchAgent is `node` talking to local apps via AppleScript. The first Mail, Calendar, or Outlook call can show:

**“node” wants to control “Mail” / “Calendar” / “Microsoft Outlook”**

Alan must click **OK**. Do not rewrite TCC.db. If a tool returns `automation_denied`, open **System Settings → Privacy & Security → Automation** and allow `node` for those apps, then retry.

After pulling new tools, reload the LaunchAgent and quit/reopen **Grok Bot.app** so `rico-openclaw` re-lists tools:

```sh
launchctl kickstart -k "gui/$(id -u)/ai.polar.rico-imessage-mcp"
```

## Notion Custom Agent (CVS Health Mail + iCal)

Notion Custom Agents connect over **public HTTPS** with a bearer token. They must not receive iMessage send, Mail send, or Outlook. This process therefore exposes a second loopback port with a **CVS Health-only** tool profile.

| Field | Value |
| --- | --- |
| **Name** | `Rico OpenClaw Mail + iCal` |
| **HTTPS endpoint** | `https://rico.tail434bbe.ts.net/notion-mcp/mcp` |
| **Authentication** | Bearer token |
| **Bearer token** | Contents of `~/Library/Application Support/OpenClaw Studio/secrets/rico-notion-mcp.token` — paste in Notion’s connection field only |
| **Tools** | `rico_local_apps_health`, `rico_mail_list_accounts`, `rico_mail_list_inbox`, `rico_mail_get`, `rico_calendar_list_calendars`, `rico_calendar_list`, `rico_calendar_upsert` |

The Notion profile auto-selects the reviewed CVS Health Apple Mail account (`alan.rosa@cvshealth.com` / account name **CVS Health**) and the CVS Health Calendar.app source. Personal iCloud/Gmail mailboxes and calendars are not listed and are rejected if requested by name.

In Notion (Business/Enterprise, Custom MCP enabled):

1. Settings → Notion AI → AI connectors → Enable Custom MCP servers.
2. Open the Custom Agent → Tools & Access → Add connection → Custom MCP server.
3. Paste the HTTPS endpoint and the Notion bearer token. Do not paste the iMessage MCP token.
4. Enable only the tools above. Leave send tools unavailable (they are not listed on this profile).

The Notion Funnel path is a **different local port** (`18792`) so a prefix-stripped Funnel request cannot reach iMessage send on `18791`.

## Polar (remote Grok Bot)

Polar (`grokbot:polar`) runs on a cloud box (`/home/box/...`). It does **not** load `~/.cursor/mcp.json` or `~/.grokbot/mcp.json` on this Mac. Those files are why Cursor on Rico already has `rico-openclaw`. Polar only sees **account / catalog connectors** (today: Gmail, Drive, Limitless, Plaud).

Grok Bot.app has a **Connectors** pane for those catalog OAuth apps. There is no menu-bar “Add Custom MCP” form. Custom MCP is added with Grok Bot’s built-in **AddMcpServer** tool, which writes a remote HTTP server onto the signed-in Cursor account. Polar then loads it like the other account connectors. A remote `url` is executed by Grok Bot’s backend, so the URL must be public HTTPS.

| Field | Value |
| --- | --- |
| **Name** | `rico-openclaw` |
| **HTTPS endpoint** | `https://rico.tail434bbe.ts.net/rico-mcp/mcp` |
| **Authentication** | Header `Authorization: Bearer <token>` |
| **Bearer token** | Contents of the token file — paste in Grok’s secret/header field only, never in Polar chat |

What Alan should do in Polar: ask Polar to **AddMcpServer** `rico-openclaw` at that URL, then paste the Bearer into the header field when Polar asks. Do not type the token into the thread.

Persist Funnel (already applied on this Mac):

```sh
# Path-only. Leaves /webhooks/sms. Does not publish Gateway 18789.
./funnel-public.sh
```

Confirm with `tailscale funnel status` that `443` lists `/rico-mcp`, `/notion-mcp`, **and** `/webhooks/sms`.

## runner.now Connected Apps

[runner.now Custom MCP](https://guides.runner.now/connections/connect-your-own-mcp) requires a **public HTTPS** URL ending in `/mcp` or `/sse`, plus optional Bearer auth. Plain HTTP and `127.0.0.1` are rejected by the form.

### What to paste

| Field | Value |
| --- | --- |
| **Name** | `Rico OpenClaw` |
| **HTTPS endpoint** | `https://rico.tail434bbe.ts.net:8444/mcp` |
| **Authentication** | **Bearer token** |
| **Bearer token** | Contents of `~/Library/Application Support/OpenClaw Studio/secrets/rico-imessage-mcp.token` — paste in that field only |
| **Tools** | `rico_imessage_send`, `rico_mail_send`, `rico_outlook_send`, `rico_calendar_upsert` → **Ask**. Health/list/get/`can_send` may stay **On**. |

Do not paste the token into a Runner session. Runner encrypts the Connected Apps field and does not show it again.

### Can runner.now’s cloud actually reach this?

**Usually no.** This Serve URL is **tailnet-only**. It is HTTPS, but it is not on the public internet.

- A Runner (or any MCP client) **on the same Tailscale tailnet** can use the URL above.
- **runner.now’s hosted cloud app cannot join this tailnet**, so Connect server from that SaaS will fail to reach Serve on 8444. Use the Polar Funnel URL below if a public HTTPS client must call Rico.
- Same-Mac clients can use `http://127.0.0.1:18791/mcp`; Runner’s hosted form will not accept that URL.

SMS Funnel on `https://rico.tail434bbe.ts.net/webhooks/sms` stays public for Twilio. MCP Funnel is **path-only** `/rico-mcp` (see Polar section). Gateway `18789` is not Funnelled.

### Persist Serve (already applied on this Mac)

```sh
# Distinct port. Does not touch Funnel :443 /webhooks/sms or Gateway 18789.
tailscale serve --bg --https=8444 http://127.0.0.1:18791
```

Confirm with `tailscale serve status` that `443` lists `/webhooks/sms` and `/rico-mcp`, and that `8444` still lists the tailnet MCP proxy.

Example tool call after connect:

```json
{
  "name": "rico_imessage_send",
  "arguments": {
    "to": "+16469433060",
    "text": "Runner finished the job.",
    "idempotencyKey": "runner-job-123"
  }
}
```

## Security model

| Layer | Rule |
| --- | --- |
| Bind | Loopback only. Tailnet clients use Serve on **8444**. Polar uses path-only Funnel `/rico-mcp`. Notion uses path-only Funnel `/notion-mcp` on a separate local port. |
| Host | Loopback or `*.tail*.ts.net` MagicDNS. Other Host headers → 403. |
| Auth | Bearer token in a `0600` file. Missing/wrong token → 401. |
| Allowlist | Guard identities + native `allowFrom` / groups. Strangers never reach `send`. |
| Gateway | This process calls loopback `ws://127.0.0.1:18789`. It does not proxy arbitrary Gateway methods. |
| Funnel | MCP is path-only `/rico-mcp` and `/notion-mcp` on 443. SMS `/webhooks/sms` is unchanged. Gateway port is not Funnelled. Notion uses a separate local port and bearer token. |
| Secrets | Token path may be printed. Token values, Gateway tokens, and account IDs are not. |

## What is not built

- Inbound iMessage bridge / webhook POST to runner.now
- Full-port public MCP (only paths `/rico-mcp` and `/notion-mcp` are Funnelled; Gateway `18789` is not)
- LAN / internet bind of the OpenClaw Gateway
- `openclaw mcp serve` (full conversation/history/approval surface)
- OpenTable MCP, Uber MCP, or any other tool catalog
- Arbitrary shell or unrestricted Gateway methods
- Group mention-policy changes (`@rico` still required in groups)

## Tests

```sh
cd /Users/alan/OpenClawStudio/RicoIMessageMCP
npm test
```

Allowlist reject/allow, `can_send`, Mail/Outlook stranger reject, Outlook-missing errors, HTTP auth, CVS Health mailbox/calendar matching, and the Notion tool profile are covered **without a live iMessage or email send**. AppleScript is mocked.
