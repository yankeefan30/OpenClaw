# Rico bring-up after the thin-guard repair

Rico stays **OFF** until Polar applies this patch on the Mac Mini and finishes QA.
Do not resume autonomy. Do not send iMessages during install. Do not disable SIP.

## What this patch changed

1. Outbound security is one rule: deny strangers. Approved / VIP / owner / `allowFrom` people always send. Grants are optional cleanup. A policy-read throw fails open for already-known approved people and still fails closed for unknown numbers.
2. `Model Fallback:` / timeout lines are stripped or cancelled before iMessage delivery, with or without the leading arrow.
3. VIP directs start Claude (`anthropic/claude-opus-4-8`), not Qwen.
4. Direct DMs use a private one-to-one prompt. They are not a public-safe group. Rico answers or escalates through the stuck-question mailbox. Never “ask Alan directly.”

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
4. **Test Alan’s own DM only.** Send one short ping from Alan’s self-chat. Expect a normal Rico reply. Expect no `Model Fallback:` line.
5. Do not text Jeff, Janet, Ana, or any group until that Alan DM is clean.

## Keep him off if anything looks wrong

```bash
openclaw gateway stop
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/<gateway-plist>
mv ~/Library/LaunchAgents/<gateway-plist> ~/Library/LaunchAgents/<gateway-plist>.disabled
```
