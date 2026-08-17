# Rico bring-up after the 2026-08-17 guard repair

Rico stays **offline** until Polar applies this on the Mac Mini. Do not start
the Gateway from this checkout. Do not send iMessages from this agent.

## What this repair changed

1. An already-approved / trusted / owner direct always sends. `--deliver`
   `event.to` may be a chat id, a session key, or a missing `to` field; the
   guard now resolves all of those to the reviewed identity. A one-shot owner
   grant is **not** required for those directs.
2. If `rico-recipient-guard.json` cannot be read, outbound **fails open** and
   logs. Strangers still fail closed when the policy is readable. Native
   `allowFrom` no longer drops a person who is already approved in the sidecar.
3. Approved / trusted / owner **directs** skip quiet hours and `@rico`. Groups
   still use both. Jeff’s 7:15 ET demo (`quietEnd=8`, `requireMention=true`)
   must start a turn.
4. Model-fallback / timeout telemetry never delivers to iMessage, with or
   without the leading arrow, including when it is prepended to a shrug.
5. ISTS/VIP directs use the `rico-vip` agent on `anthropic/claude-opus-4-8`,
   a private 1:1 prompt (not “shared, public-safe space”), and Polar-mailbox
   escalation. Rico stays the speaker. Qwen remains the shared/group local
   model only.

## Polar apply order (Mac Mini)

Keep `ai.openclaw.gateway.plist.disabled` in place until step 6.

1. **Install the reviewed code**
   - Merge or cherry-pick this branch onto the Mini’s OpenClaw Studio tree.
   - Package Studio if that is how the Mini deploys, or copy the plugin trees
     into the live install paths Polar already uses.

2. **Install plugins (Gateway still down)**

   ```bash
   openclaw plugins install --force "/Applications/OpenClaw Studio.app/Contents/Resources/RicoRecipientGuard"
   openclaw plugins install --force "/Applications/OpenClaw Studio.app/Contents/Resources/RicoVipRoute"
   openclaw plugins enable rico-recipient-guard
   openclaw plugins enable rico-vip-route
   openclaw config set plugins.entries.rico-recipient-guard.hooks.allowConversationAccess true
   openclaw config set plugins.entries.rico-recipient-guard.hooks.allowPromptInjection true
   openclaw config set plugins.entries.rico-recipient-guard.enabled true
   openclaw config set plugins.entries.rico-vip-route.enabled true
   ```

   Confirm `plugins.allow` contains `rico-recipient-guard` and `rico-vip-route`.
   Do **not** re-enable autonomy plugins.

3. **Mark Jeff as VIP in the sidecar** (if the ISTS grant is not readable)

   Edit `~/Library/Application Support/OpenClaw Studio/rico-recipient-guard.json`
   identity 19 (Jeff, `+18148814454`):

   - `"access": "approved"` (or `trusted`)
   - `"autoReply": true`
   - `"vip": true`
   - `"directChatId": <Jeff’s Messages chat id>` if Polar has it
   - keep `0600` on the file and `0700` on the support directory

   Quiet hours may stay `22`/`8`. They no longer drop his **direct**.

4. **Reset the poisoned VIP session**

   Session `3a2c545d-31fd-4789-8eb3-571a4af6f244` sat on Qwen. After bind to
   `rico-vip`, reset that session (Studio session reset or
   `openclaw sessions reset` for that id) so history is not reused across
   agents.

5. **Re-enable the LaunchAgent**

   ```bash
   launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.gateway.plist.disabled 2>/dev/null || true
   mv ~/Library/LaunchAgents/ai.openclaw.gateway.plist.disabled \
      ~/Library/LaunchAgents/ai.openclaw.gateway.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.gateway.plist
   launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
   ```

   If the Mini uses a different plist name, use that name. Confirm port
   **18789** is listening only after this step.

6. **Health**

   ```bash
   openclaw gateway status
   # operator.read
   # rico.recipient.status must report version 0.5.8 and contract rico-recipient-guard/v6
   ```

7. **Alan’s own DM first**

   From Alan’s phone, send a normal DM (no `@rico` required). Expect a Claude
   or owner-main reply in Rico’s voice. Confirm **no**
   `Model Fallback:` / `timeout` line lands in Messages.

8. **One VIP (Jeff) second**

   Jeff texts without `@rico`, including before 08:00 ET. Expect:

   - automatic turn starts
   - model is `anthropic/claude-opus-4-8`, not Qwen
   - answer or Polar-mailbox escalation
   - never “shared, public-safe space”, “ask Alan directly”, or fallback
     telemetry

9. **Abort**

   If any of those fail, take Rico offline the same way as the incident:
   stop the Gateway, disable the LaunchAgent
   (`mv …/ai.openclaw.gateway.plist …/ai.openclaw.gateway.plist.disabled`),
   confirm 18789 is down.

## Do not

- Resume autonomy
- Disable SIP
- Send iMessages from Cursor / this PR runtime
- Invent a second speaker
- Leave `rico-recipient-guard` disabled after a successful Alan + Jeff test
