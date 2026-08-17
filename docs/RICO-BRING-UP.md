# Rico bring-up after the 2026-08-17 unsolicited-send repair

Rico stays **offline** until Polar says otherwise. Do not start the Gateway
from this checkout. Do not send iMessages from this agent. Do not disable SIP.
Do not dump tokens, Keychain, or phone numbers.

## Live ground truth

### Morning (7:40–7:55 ET) — bad replies in threads that already had inbound

Not a blast. 11 outbound from Alan’s line into **2 chats only**:

1. **Jeff Roach DM** — `chat_id=9`, session `3a2c545d-31fd-4789-8eb3-571a4af6f244`, key `agent:rico-shared:imessage:default:direct`, last4 `4454`.
   - 07:42:17 Claude intro was fine.
   - 07:45:37 leaked `blocked by rico-recipient-guard`.
   - 07:46:44 leaked `Model Fallback: … selected model unavailable`, then a wrong “not Jeff’s DM” shrug.
2. **Ana Tramont + Janet Cummings GROUP** — `chat_id=24`, session `b49ab4de-b7cf-4acb-aac3-f4753266273f`, key `agent:rico-shared:imessage:group:24`. No Janet DM. No Ana DM.
   - Qwen 200 in 32ms with no content, then leaked `Model Fallback: … timeout`.
   - 07:46:43 public-safe shrug: “shared, public-safe space… ask Alan directly.”

Guard was present at 07:43:44 (20 plugins) and gone after 07:46:06 (19 plugins). Default model stayed Qwen.

### Evening (8:45–8:51 ET) — Rico initiated

Worse than the morning. Polar brought the Gateway up only so Alan could send
his own DM. Rico then texted people who had not written, including Al Sassoon
(VIP). Polar took Rico down again (LaunchAgent disabled, 18789 down,
`intentional_offline` true). **Do not bring him back.**

Root cause: guard 0.5.8 last-mile treated approved / VIP / owner identity as
enough to deliver. Gateway start resumed or flushed a `rico-shared` turn.
Live `imessage:default:direct` is a shared session bucket, not a person, and
`isVipDirectTurn` returned true for any default:direct. Last-mile banner
cancel does not stop a normal-looking unsolicited hello.

## What this repair changed (guard 0.5.9)

1. Rico never sends an iMessage unless that **exact thread** had a new human
   inbound during **this Gateway uptime**. Thread keys are chat id / handle.
   `default:direct` is never a thread.
2. Gateway start, session resume, queued assistant flush, heartbeat, cron,
   and catch-up cannot deliver. A VIP flag, a session, or default:direct
   matching is not a send.
3. Approved / VIP / owner still always send when **they** message. Fail open
   for those people on a real inbound. Fail closed for strangers. No grants
   required. No `rico-vip` agent. No session reset.
4. Groups still need the existing mention / quiet rules.
5. Last-mile still cancels Model Fallback / guard-block / empty-turn /
   public-safe shrugs.
6. `default:direct` alone is not a VIP Claude pin. Jeff `chat_id=9` still
   pins Claude when Jeff is the sender.

## Polar apply order (Mac Mini)

Keep `ai.openclaw.gateway.plist.disabled` in place. **Gateway stays down
until Polar says.** Prove “no outbound without inbound” **before** Alan’s DM.

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

   Confirm guard version **0.5.9**. Do **not** re-enable autonomy plugins.
   Do **not** create a `rico-vip` agent. Do **not** reset sessions.

3. **Set Jeff’s live chat id** (still down)

   In `~/Library/Application Support/OpenClaw Studio/rico-recipient-guard.json`,
   Jeff (`+18148814454` / last4 4454): `"directChatId": 9`.
   Confirm Ana+Janet remains `chat_id:24`. Keep `0600` / `0700`.

4. **QA before Polar says the Gateway may come up**

   From this checkout, with the Gateway still down:

   ```bash
   node --test OpenClawPlugin/qa-incident-repair.test.mjs OpenClawPlugin/policy.test.mjs RicoVipRoute/route.test.mjs
   ```

   Those tests must fail if:

   1. Gateway start / session resume / queued assistant would deliver with no
      inbound in this uptime.
   2. `default:direct` alone is treated as a VIP send.
   3. Al Sassoon (or any VIP) can be texted with no inbound on that thread.

   Also still true:

   4. Unknown recipient denied.
   5. Approved inbound still allowed: Jeff `chat_id=9` on `default:direct`,
      Al if he writes, Alan owner DM. Empty grants / throwing policy read
      fail open only on that real inbound.
   6. Fallback / timeout / unavailable / guard-block / empty-turn /
      public-safe shrugs never delivered.
   7. VIP session model is Claude only when the sender is a VIP handle.
   8. Ana+Janet-style colleague group does not emit the public-safe ORIBE shrug.

5. **Polar proves “no outbound without inbound.”** Write that proof down.
   Do not start the Gateway for Alan’s DM until Polar says the proof holds.
   Keep 18789 down and the LaunchAgent disabled until then.

6. **Only after Polar says:** re-enable the LaunchAgent

   ```bash
   mv ~/Library/LaunchAgents/ai.openclaw.gateway.plist.disabled \
      ~/Library/LaunchAgents/ai.openclaw.gateway.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.gateway.plist
   openclaw gateway start
   ```

   If the Mini uses a different plist name, use that name. Confirm port
   **18789** is listening only after this step. On bring-up, Rico must send
   **zero** iMessages until a human writes.

7. **Alan’s own DM first**, and only after Polar says. Expect no
   `Model Fallback:`, no guard-block banner, and no texts to anyone else.
   Do not text Jeff, Al, Ana, Janet, or the group until that Alan DM is clean
   and no unsolicited outbound occurred.

8. **Abort** the same way as the incident: stop the Gateway, rename the plist
   `.disabled`, confirm 18789 is down.

## Do not

- Start the Gateway before Polar says
- Resume autonomy
- Disable SIP
- Send iMessages from Cursor / this PR runtime
- Invent a wider blast
- Create a `rico-vip` agent
- Reset sessions
- Leave `rico-recipient-guard` disabled after a successful Alan DM test
