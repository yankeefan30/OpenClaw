# Rico bring-up after the 2026-08-17 guard repair

Rico stays **offline** until Polar applies this on the Mac Mini. Do not start
the Gateway from this checkout. Do not send iMessages from this agent.

## Live ground truth (7:40–7:55 ET)

Not a blast. 11 outbound from Alan’s line into **2 chats only**:

1. **Jeff Roach DM** — `chat_id=9`, session `3a2c545d-31fd-4789-8eb3-571a4af6f244`, key `agent:rico-shared:imessage:default:direct`, last4 `4454`.
   - 07:42:17 Claude intro was fine.
   - 07:45:37 leaked `blocked by rico-recipient-guard`.
   - 07:46:44 leaked `Model Fallback: … selected model unavailable`, then a wrong “not Jeff’s DM” shrug.
2. **Ana Tramont + Janet Cummings GROUP** — `chat_id=24`, session `b49ab4de-b7cf-4acb-aac3-f4753266273f`, key `agent:rico-shared:imessage:group:24`. No Janet DM. No Ana DM.
   - Qwen 200 in 32ms with no content, then leaked `Model Fallback: … timeout`.
   - 07:46:43 public-safe shrug: “shared, public-safe space… ask Alan directly.”

Guard was present at 07:43:44 (20 plugins) and gone after 07:46:06 (19 plugins). Default model stayed Qwen.

## What this repair changed

1. Strangers fail closed. Approved / VIP / owner / `allowFrom` always send. Grants are not required. Policy-read throws fail open.
2. `Model Fallback:` / timeout / unavailable, `blocked by rico-recipient-guard`, and `[assistant turn failed before producing content]` never deliver. An empty Qwen 32ms 200 is not a user-visible timeout.
3. Approved directs start Claude on the live `imessage:default:direct` session. No `vip: true` flag and no new `rico-vip` agent are required.
4. Direct DMs use a private one-to-one prompt. Ana+Janet `chat_id:24` uses a colleague prompt. Neither is a shared public-safe space. Last-mile also cancels “ask Alan directly” shrugs.

## Polar apply order (Mac Mini)

Keep `ai.openclaw.gateway.plist.disabled` in place until step 5.

1. **Install the reviewed code** from this branch. Gateway stays down.

2. **Install plugins (Gateway still down)**

   ```bash
   openclaw plugins install --force "$PWD/OpenClawPlugin"
   openclaw plugins install --force "$PWD/RicoVipRoute"
   openclaw plugins enable rico-recipient-guard
   openclaw plugins enable rico-vip-route
   openclaw config set plugins.entries.rico-recipient-guard.hooks.allowConversationAccess true
   openclaw config set plugins.entries.rico-recipient-guard.hooks.allowPromptInjection true
   ```

   Confirm guard version **0.5.8**. Do **not** re-enable autonomy plugins.

3. **Set Jeff’s live chat id**

   In `~/Library/Application Support/OpenClaw Studio/rico-recipient-guard.json`,
   Jeff (`+18148814454` / last4 4454): `"directChatId": 9`.
   Confirm Ana+Janet remains `chat_id:24`. Keep `0600` / `0700`.
   Do not create a `rico-vip` agent. Do not reset session `3a2c545d-…` unless
   it is still poisoned after Alan’s DM test.

4. **QA before bring-up**

   1. Unknown recipient denied.
   2. Approved VIP allowed with empty grants / throwing policy read. Live shape: Jeff `chat_id=9` on `default:direct`.
   3. Fallback / timeout / unavailable / guard-block / empty-turn lines never delivered.
   4. VIP session model is Claude, not Qwen.
   5. Direct DM is not the public-safe/group shrug path.
   6. Ana+Janet-style colleague group does not emit the public-safe ORIBE shrug.

5. **Re-enable the LaunchAgent**

   ```bash
   mv ~/Library/LaunchAgents/ai.openclaw.gateway.plist.disabled \
      ~/Library/LaunchAgents/ai.openclaw.gateway.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.gateway.plist
   openclaw gateway start
   ```

   If the Mini uses a different plist name, use that name. Confirm port
   **18789** is listening only after this step.

6. **Alan’s own DM first.** Expect no `Model Fallback:` and no guard-block banner.
   Do not text Jeff, Ana, Janet, or the group until that Alan DM is clean.

7. **Abort** the same way as the incident: stop the Gateway, rename the plist
   `.disabled`, confirm 18789 is down.

## Do not

- Resume autonomy
- Disable SIP
- Send iMessages from Cursor / this PR runtime
- Invent a wider blast
- Leave `rico-recipient-guard` disabled after a successful Alan DM test
