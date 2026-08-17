# Rico Lindy local bridge

Lindy is Rico’s only messaging front door. This package is **not** a speaker
and **not** a general agent runtime. It is a thin, authenticated HTTP bridge
so a Lindy workflow can ask the original Rico Mac Mini to touch the two
things Lindy cannot: **CVS Health email** and **CVS Health calendar**, through
the local Microsoft Outlook and Calendar.app clients already used by
`RicoIMessageMCP` / `RicoEmailGovernance`.

iMessage / Messages stays off. There is no chat turn, no `openclaw mcp serve`,
and no iMessage send path.

## Surface

`POST /lindy/local-bridge`

| Tool | Local client | What it does |
| --- | --- | --- |
| `health` | Outlook + Calendar.app | Reachability only. No tokens or account IDs. |
| `outlook_list_inbox` | Outlook | Bounded recent inbox metadata. |
| `outlook_search` | Outlook | Filter that bounded inbox list by subject/from. |
| `outlook_get` | Outlook | One inbox message by id. Body truncated. |
| `outlook_draft` | Outlook | Create a draft to an approved recipient. Does **not** send. |
| `calendar_list` | Calendar.app | Bounded upcoming events. |
| `calendar_upsert` | Calendar.app | Create/update one local event. No attendees. |

Rejected on purpose: `rico_imessage_*`, Apple Mail tools, `rico_outlook_send`,
`ask` / `chat` / any general Rico prompt.

## Polar — stand this up

1. Keep Messages off. In `~/.openclaw/openclaw.json` leave
   `channels.imessage.enabled` **false**. Do not apply Studio’s
   communications projection that turns iMessage back on. Do not start
   `RicoIMessageMCP` as a speaker.
2. Copy the committed example and keep the live file private (names +
   workflow IDs only; no phones, emails, or tokens):

   ```sh
   mkdir -p "$HOME/Library/Application Support/OpenClaw Studio"
   cp RicoLindyBridge/allowlist.example.json \
     "$HOME/Library/Application Support/OpenClaw Studio/lindy-local-bridge.allowlist.json"
   chmod 600 "$HOME/Library/Application Support/OpenClaw Studio/lindy-local-bridge.allowlist.json"
   ```

   Edit workflow IDs to match the Lindy workflows that may call each tool.
   Recipient emails stay in the existing private person-email authorizations
   file. Do not put addresses in the allowlist.
3. Create the bearer token (prints the **path** only):

   ```sh
   cd /Users/alan/OpenClawStudio/RicoLindyBridge
   node index.mjs --init-token
   ```

   Token file: `~/Library/Application Support/OpenClaw Studio/secrets/rico-lindy-bridge.token` (`0600`).
4. Start the loopback server (LaunchAgent optional):

   ```sh
   node index.mjs
   # listens on http://127.0.0.1:18792/lindy/local-bridge
   ```

5. Publish **this path only** on Tailscale. Do not Funnel Gateway `18789`.
   Do not Funnel `/mcp`. Example path-only Serve/Funnel:

   ```sh
   tailscale serve --bg --https=8445 http://127.0.0.1:18792
   ```

   Confirm `tailscale serve status` / `funnel status` does **not** list
   Messages, Gateway 18789, or `/mcp` for this process.

## Polar — point Lindy’s HTTP Request at it

In the Lindy workflow HTTP Request node:

| Field | Value |
| --- | --- |
| Method | `POST` |
| URL | Tailnet/Serve URL ending in `/lindy/local-bridge` (not `/mcp`) |
| Header | `Authorization: Bearer <token>` — paste from the token file into Lindy’s secret field only |
| Body | JSON below |

```json
{
  "workflowId": "lindy-cvs-mail-read",
  "tool": "outlook_list_inbox",
  "arguments": { "limit": 10 }
}
```

`workflowId` must match the local allowlist. A workflow that is only
allowlisted for read cannot draft. Unknown callers get 401. Unknown
workflows and forbidden tools get 403. No model turn runs.

Draft example (approved recipient only; stays a draft):

```json
{
  "workflowId": "lindy-cvs-mail-draft",
  "tool": "outlook_draft",
  "arguments": {
    "to": "<from local person-email authorization, never committed>",
    "subject": "Follow-up",
    "text": "Draft created on the Mac Mini. Not sent."
  }
}
```

Calendar stays on Calendar.app. Name the exact local calendar (often the
Exchange/CVS calendar already synced on this Mac). No attendees are invited.

## What stays local

- Outlook and Calendar.app AppleScript on this Mac Mini.
- Existing Rico person-email authorizations for draft recipients.
- Bearer token and live allowlist on disk, mode `0600`, gitignored.

Nothing in this repo is a phone number, token, or Keychain secret.

## Tests

```sh
cd RicoLindyBridge
npm test
```

Proofs: unauthorized caller rejected; mail/calendar tools only; no iMessage
path; no general “ask Rico anything” endpoint; stranger draft rejected.
