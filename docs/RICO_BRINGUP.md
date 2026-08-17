# Rico bring-up after the thin-guard repair

Rico stays **OFF** until Polar applies this patch on the Mac Mini and finishes QA.
Do not resume autonomy. Do not send iMessages during install. Do not disable SIP.
Do not start the gateway from this cloud agent.

## Live ground truth (2026-08-17 7:40–7:55 ET)

Not a blast. 11 outbound from Alan’s line into **2 chats only**:

1. **Jeff Roach DM** — `chat_id=9`, session `3a2c545d-31fd-4789-8eb3-571a4af6f244`, key `agent:rico-shared:imessage:default:direct`, last4 `4454`.
   - 07:42:17 Claude intro was fine.
   - 07:45:37 leaked `blocked by rico-recipient-guard`.
   - 07:46:44 leaked `Model Fallback: … selected model unavailable`, then a wrong “not Jeff’s DM” shrug.
2. **Ana Tramont + Janet Cummings GROUP** — `chat_id=24`, session `b49ab4de-b7cf-4acb-aac3-f4753266273f`, key `agent:rico-shared:imessage:group:24`. No Janet DM. No Ana DM.
   - 07:46:24 inbound `@rico` training + ORIBE awards.
   - Qwen `127.0.0.1:1234/v1/responses` status=200 in 32ms, then `[assistant turn failed before producing content]`.
   - Leaked `Model Fallback: … timeout` (reason is in the iMessage body; gateway.log has no literal timeout line).
   - 07:46:43 public-safe shrug: “shared, public-safe space… ask Alan directly.”

Gateway.log last write 07:48:16 ET. Guard hot-reloaded 07:41, then SIGTERM restarts. 07:43:44 still listed rico-recipient-guard (20 plugins). 07:46:06+ restarts list 19 plugins; guard gone. Default model stayed Qwen.

## What this patch changed

1. Outbound security is one rule: deny strangers. Approved / VIP / owner / `allowFrom` people always send. Grants are optional cleanup. A policy-read throw fails open for already-known approved people and still fails closed for unknown numbers.
2. `Model Fallback:` / timeout / unavailable banners, `blocked by rico-recipient-guard`, and `[assistant turn failed before producing content]` are stripped or cancelled before iMessage delivery. An empty Qwen 32ms 200 is not a user-visible timeout.
3. VIP directs start Claude (`anthropic/claude-opus-4-8`), including live `imessage:default:direct`. Not Qwen.
4. Direct DMs use a private one-to-one prompt. They are not a public-safe group. Rico answers or escalates through the stuck-question mailbox. Never “ask Alan directly.”
5. Known colleague groups (`chat_id:24` Ana+Janet, and other approved groups) use a colleague prompt. They may discuss training/awards. They are not a shared public-safe space.
6. Approved/VIP individuals may carry `directChatId` so Jeff’s live `chat_id:9` still authorizes after a gateway restart. Polar should set Jeff Roach `directChatId: 9` in `rico-recipient-guard.json`.

## QA Polar must prove before bring-up

1. Unknown recipient denied.
2. Approved VIP allowed even if grants dir empty / policy read would throw. Live shape: Jeff `chat_id=9` on `agent:rico-shared:imessage:default:direct`.
3. Model-fallback / timeout / unavailable / guard-block / empty-assistant-turn lines never delivered.
4. VIP session model is Claude, not Qwen.
5. Direct DM is not the public-safe/group shrug path.
6. Ana+Janet-style colleague group does not emit the public-safe ORIBE shrug.

## Install on the Mac Mini

Rico’s LaunchAgent must remain disabled until step 4.

```bash
# From this repo, after Polar merges or checks out the repair branch:
openclaw plugins install --force "$PWD/OpenClawPlugin"
openclaw plugins enable rico-recipient-guard
openclaw config set plugins.entries.rico-recipient-guard.hooks.allowConversationAccess true
openclaw config set plugins.entries.rico-recipient-guard.hooks.allowPromptInjection true

openclaw plugins install --force "$PWD/RicoVipRoute"
openclaw plugins enable rico-vip-route
```

If Studio has already been packaged with this revision:

```bash
openclaw plugins install --force "/Applications/OpenClaw Studio.app/Contents/Resources/RicoRecipientGuard"
openclaw plugins install --force "/Applications/OpenClaw Studio.app/Contents/Resources/RicoVipRoute"
openclaw plugins enable rico-recipient-guard
openclaw plugins enable rico-vip-route
```

Confirm the live guard reports `0.5.8` before touching the gateway.
In `rico-recipient-guard.json`, set Jeff Roach `directChatId: 9`. Confirm Ana+Janet remains `chat_id:24`.

## Re-enable the gateway (Polar only, after QA)

1. Restore the LaunchAgent plist. It was renamed with a `.disabled` suffix:
   ```bash
   ls ~/Library/LaunchAgents/*openclaw* ~/Library/LaunchAgents/*gateway*
   mv ~/Library/LaunchAgents/<gateway-plist>.disabled ~/Library/LaunchAgents/<gateway-plist>
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<gateway-plist>
   ```
   Use the exact original filename Polar disabled. Do not create a new agent.
2. Start the gateway:
   ```bash
   openclaw gateway start
   ```
3. Confirm port `18789` is listening locally. Do not expose it.
4. **Test Alan’s own DM only.** Send one short ping from Alan’s self-chat. Expect a normal Rico reply. Expect no `Model Fallback:` line and no guard-block banner.
5. Do not text Jeff, Janet, Ana, or the Ana+Janet group until that Alan DM is clean.

## Keep him off if anything looks wrong

```bash
openclaw gateway stop
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/<gateway-plist>
mv ~/Library/LaunchAgents/<gateway-plist> ~/Library/LaunchAgents/<gateway-plist>.disabled
```
