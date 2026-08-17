# Rico Lindy local bridge

Lindy is Rico’s only messaging front door. Polar does personality. Polar/Cursor
get the Mac Mini workflows into Lindy. This package is **not** a speaker and
**not** a general agent runtime.

It is a thin, authenticated loopback bridge so Lindy can ask **original Rico**
(`Rico.local` only) to touch the two things Lindy cannot: **CVS Health email**
and **CVS Health calendar**, through the local Microsoft Outlook and
Calendar.app clients already used by `RicoIMessageMCP` / `RicoEmailGovernance`.

**Lindy is cloud SaaS. It cannot call `127.0.0.1` on Rico.** The process binds
loopback. Polar publishes an HTTPS URL with Tailscale Serve/Funnel. Do not
bind `0.0.0.0`. Do not open a raw public port. Do not apply this on Rico 2
(Goon owns Rico 2). Do not start the OpenClaw Gateway. iMessage stays off.

## Surfaces

Same bearer token and the same workflow allowlist.

| Path | What Lindy uses |
| --- | --- |
| `POST /lindy/mcp` | **Add MCP** (streamable HTTP). This is the field Lindy Integrations → MCP wants. |
| `POST /lindy/local-bridge` | Optional HTTP Request node. Not a chat turn. |

| Tool | Local client | What it does |
| --- | --- | --- |
| `health` | Outlook + Calendar.app | Reachability only. No tokens or account IDs. |
| `outlook_list_inbox` | Outlook | Bounded recent inbox metadata. |
| `outlook_search` | Outlook | Filter that bounded inbox list by subject/from. |
| `outlook_get` | Outlook | One inbox message by id. Body truncated. |
| `outlook_draft` | Outlook | Create a draft to an approved recipient. Does **not** send. |
| `calendar_list` | Calendar.app | Bounded upcoming events. |
| `calendar_upsert` | Calendar.app | Create/update one local event. No attendees. |

Rejected: `rico_imessage_*`, Apple Mail, `rico_outlook_send`, `ask` / `chat`,
Teams, Slack. CVS Teams/Slack come later only if a local client on Rico.local
can do it without connecting Microsoft/Slack to Lindy. Not in this drop.

MCP tool calls use allowlist workflow `lindy-mcp` unless the call passes
`workflowId`.

## Polar — apply on Rico.local only

Confirm the shell is original Rico before anything else:

```sh
hostname
# must be Rico or Rico.local — stop if this is Rico 2
```

The process refuses to listen on any other hostname. Do not export
`RICO_LINDY_BRIDGE_ALLOW_NON_RICO` on a real Mac. Do not copy this tree onto
Rico 2. Do not start `openclaw` / Gateway / iMessage.

1. Keep Messages off. In `~/.openclaw/openclaw.json` leave
   `channels.imessage.enabled` **false**. Do not start `RicoIMessageMCP` as a
   speaker. Gateway stays down.
2. Copy the committed example to the private live file (names + workflow IDs
   only; no phones, emails, or tokens):

   ```sh
   mkdir -p "$HOME/Library/Application Support/OpenClaw Studio"
   cp RicoLindyBridge/allowlist.example.json \
     "$HOME/Library/Application Support/OpenClaw Studio/lindy-local-bridge.allowlist.json"
   chmod 600 "$HOME/Library/Application Support/OpenClaw Studio/lindy-local-bridge.allowlist.json"
   ```

   Recipient emails stay in the existing private person-email authorizations
   file. Do not put addresses in the allowlist.
3. Create the bearer token (prints the **path** only — never paste the value
   into this PR, Polar chat, or a commit):

   ```sh
   cd /Users/alan/OpenClawStudio/RicoLindyBridge
   node index.mjs --init-token
   ```

   Token file: `~/Library/Application Support/OpenClaw Studio/secrets/rico-lindy-bridge.token` (`0600`).
4. Start the loopback server (LaunchAgent optional):

   ```sh
   node index.mjs
   # http://127.0.0.1:18792/lindy/mcp
   # http://127.0.0.1:18792/lindy/local-bridge
   ```

   That URL is for this Mac only. **Do not give Lindy `127.0.0.1`.**

## Polar — Tailscale reachability (not an open port)

The Node process never Funnel’s itself and never binds the LAN.

| Step | When | Command |
| --- | --- | --- |
| Tailnet Serve | Polar testing from another tailnet node | `./serve-tailnet.sh` → HTTPS **8445** → `http://127.0.0.1:18792` |
| Funnel | **Only when Polar flips it** so Lindy cloud can reach Rico | `./funnel-lindy.sh` → path `/lindy` on 443 |

Lindy’s cloud workers are not on this tailnet. Serve on 8445 is not enough
for Integrations → MCP. Funnel is the HTTPS URL Lindy can call. It is
**off until Polar runs `funnel-lindy.sh`**. Confirm:

```sh
tailscale serve status
tailscale funnel status
```

443 may already list `/webhooks/sms` and `/rico-mcp`. This Funnel adds
**`/lindy` only**. It must not list Gateway `18789`, must not bind
`0.0.0.0`, and must not republish iMessage `/mcp`.

Read the MagicDNS name from `tailscale status` on Rico.local. Do not invent
one in chat.

## Polar — give Lindy the MCP URL (no secrets in the PR)

In Lindy: **Integrations → MCP → Add MCP** (streamable HTTP).

| Field | What Polar pastes |
| --- | --- |
| Name | `rico-local-bridge` |
| URL | `https://<Rico.local MagicDNS from tailscale status>/lindy/mcp` |
| Auth | Bearer token. Polar opens the token file on Rico.local and pastes the value into Lindy’s secret/header field only. |

Do not put the token, the live allowlist, or phone numbers in the PR, in
git, or in Polar chat. If Lindy rejects a URL that is not HTTPS or does not
end in `/mcp`, the Funnel URL above is the one that satisfies both.

Optional HTTP Request node (same token, same allowlist):

```json
{
  "workflowId": "lindy-cvs-mail-read",
  "tool": "outlook_list_inbox",
  "arguments": { "limit": 10 }
}
```

Drafts stay drafts. Calendar upsert invites no attendees.

## What stays local

- Outlook and Calendar.app AppleScript on Rico.local.
- Existing Rico person-email authorizations for draft recipients.
- Bearer token and live allowlist on disk, mode `0600`, gitignored.

## Tests

```sh
cd RicoLindyBridge
npm test
```

Proofs: unauthorized caller rejected; MCP streamable HTTP lists mail/calendar
only; stranger draft rejected; no iMessage / outlook_send / chat path;
hostname refuses Rico 2; Funnel is Polar-flip only.
