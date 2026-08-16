# Rico owner-command route

`imsg-owner-route.mjs` is a transparent JSON-RPC proxy for the bundled OpenClaw
iMessage channel. OpenClaw intentionally drops ordinary `is_from_me` traffic.
The proxy changes only the `is_from_me` bit for a message that satisfies every
reviewed owner-command constraint:

- it is a group message;
- its numeric chat ID is explicitly allowed;
- its sender and destination are the same exact configured owner handle;
- that handle is explicitly configured as an owner; and
- the text begins with the literal `@rico` command handle.

The proxy also retains one process-local direct owner self-chat route for five
minutes when a live notification supplies exact evidence: a positive numeric
chat ID, `is_group: false`, owner-matching sender and destination, and a
timestamp at or after the policy fence. During that window only an iMessage
JSON-RPC `send` request whose sole handle target is that same reviewed owner is
rewritten from `to` to the observed `chat_id`. The exact rewrite also removes
`reply_to` so an AppleScript retry cannot repeat an unsupported historical
thread target. History rows never seed this route, and policy unavailability or
pause clears it. Group targets, non-owner sends, SMS/auto sends, other methods,
and sends without fresh evidence pass through unchanged.

OpenClaw's native sender/group allowlists, persistent inbound dedupe, echo
cache, mention gating and the Rico Recipient Guard remain authoritative after
these narrow normalizations. Unknown and non-JSON protocol lines are relayed
unchanged.

The default policy is read from:

`~/Library/Application Support/OpenClaw Studio/rico-owner-command-route.json`

Both its directory (`0700`) and policy file (`0600`) must be private and owned
by the Gateway user. The schema is:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "ownerHandles": ["<exact iMessage sender handle>"],
  "allowedGroupChatIds": [24],
  "notBeforeMs": 1786795200000
}
```

Studio installs the bundled script at a content-addressed executable path
`~/Library/Application Support/OpenClaw Studio/bin/<sha256>/imsg` (private mode
`0700`) and projects that exact path into `channels.imessage.cliPath`. A code
upgrade therefore changes the path and forces an iMessage channel reload, while
the `imsg` basename preserves OpenClaw's local Messages behavior. The route delegates to
`/opt/homebrew/bin/imsg`; no SIP or private API bridge changes are involved.

Run the isolated tests with:

```sh
node --test IMsgOwnerRoute/imsg-owner-route.test.mjs
```
