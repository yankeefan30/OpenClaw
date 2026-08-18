# Rico inbound text on Lindy

Lindy is Rico’s only front door. This note is the product finding for
inbound **text**, not calls. Polar owns personality. Do not edit Rico’s
Context, Greeting, or prompt. Do not start iMessage or the OpenClaw
Gateway. Do not work on Rico 2. Do not release the purchased Lindy Phone
line. Do not buy another Lindy number. Do not write approved or VIP
phone numbers into this repo, chat, memory, or Lindy by hand.

Investigated independently against current Lindy docs and product pages
on 2026-08-18. Polar’s earlier “voice-only” read is **not** treated as
the source of truth. The conclusion below is from the product itself.

## Verdict

**The purchased Lindy Phone line cannot receive inbound SMS into the
custom Rico agent and have Rico reply by text.**

Alan’s green-bubble “Rico” text getting no reply is the expected
outcome of the current product, not a missed assignment click.

Polar was **right** that Lindy Phone has no inbound-SMS trigger for a
custom agent. Polar was **incomplete**, not wrong, about the phrase
“SMS capable”: that phrase is real in Lindy’s phone docs, and the
marketing blog overclaims “a call or text routes to the agent.” Neither
one exposes an **SMS Received** trigger under Lindy Phone.

Do not connect Twilio from this repo. Twilio is the documented working
inbound-text path for a **custom** agent named Rico. Polar was not
authorized to add that account. Wait for Alan before connecting
anything.

## What “SMS capable” actually means

Official Lindy Phone docs list a $10/month number as:

- concurrent calls
- SMS capable
- managed at Settings → Phone Numbers

The same page’s inbound path is a **phone trigger that starts a call**.
The phone-specific skills are **End Call**, **Press Numbers**, and
**Transfer Call**. Example voice prompts list **Send SMS** as a skill
the voice agent can use **during or after a live call** (booking links,
follow-ups). That is outbound SMS as a call-adjacent action, not
“someone texts this number and Rico wakes.”

Phone 101 docs match Polar’s UI:

- inbound = **Call Received**
- outbound = **Make Phone Call**
- buy a number from those two nodes
- Settings → Phone Numbers options are Disconnect or Release
- no SMS capability toggle

Changelog entries for Lindy Phone are call latency, voices, templates,
and call output references. There is no Lindy Phone inbound-SMS launch.

So: the $10 line can sit on Lindy’s telephony stack and can be used to
**send** SMS from a voice workflow. It does not give Rico an inbound
text front door.

## Evidence (current product)

| Claim | Source |
| --- | --- |
| Lindy Phone is a voice agent. Inbound starts a call. | https://docs.lindy.ai/skills/by-lindy/lindy-phone |
| Same page: $10 numbers are “SMS capable”; example skills include Send SMS on a **phone call** | same URL |
| Inbound trigger name is **Call Received**. Number purchase is from Call Received or Make Phone Call. Number UI is Disconnect / Release. | https://docs.lindy.ai/fundamentals/lindy-101/phone-calls |
| Custom-agent chat wake is **Message Received** (Lindy chat), not SMS | https://docs.lindy.ai/fundamentals/lindy-101/triggers |
| Personal iMessage/SMS is Settings → General on the **owner’s** phone. It texts the default Lindy assistant. | https://docs.lindy.ai/features/imessage-sms |
| Only first-class **SMS Received** trigger in Lindy docs is Twilio | https://docs.lindy.ai/skills/popular-integrations/twilio |
| Lindy staff on community: “We don't have a native Lindy SMS, but we do have integrations that can SMS like Twilio” | https://community.lindy.ai/x/support/jts2pypcgmsv/inquiry-about-lindy-sms-functionality-in-actions |
| Marketing blog says a call **or text** to an AI number routes to the agent. That is generic 2026 marketing, not the Lindy Phone trigger list. | https://www.lindy.ai/blog/ai-phone-numbers |
| Other inbound-SMS catalogs (still third-party): Plivo **New Sms Received**, RingCentral **New Inbound Sms**, SMSTools / Salesmsg / Team SMS / ClickSend | Lindy integrations catalog |

What Polar saw in the Rico editor matches current docs: **Message
Received** is the Lindy chat greeting, **Call Received** is the only
Lindy Phone trigger, SMS search hits third-party apps, Settings → Phone
Numbers has no SMS toggle and later showed the line unused. Unused
means the voice trigger is not assigned. It would not make inbound SMS
work even if it were assigned.

## Paths that are not the Rico text front door

Do **not** do these:

1. **Rebind Settings → General / Text message service / How to reach
   me.** That number is hardcoded to the default Lindy assistant. Alan
   owns that path. Leave it.
2. **Call Received on the Lindy Phone line.** Alan wants text, not
   calls. Do not build a call tree to “solve” SMS.
3. **Message Received only.** That is Lindy web chat, not SMS.
4. **Talk-with-other-Lindy relay through the default assistant.** Native,
   but owner-only and Rico is not the front door.
5. **Release the purchased Lindy Phone line.** Keep it. Do not buy
   another Lindy number.
6. **Connect CVS Slack, Teams, Microsoft, or CVS Google to Lindy.**
7. **Bring iMessage / OpenClaw Gateway up.**
8. **Type approved numbers into Rico Context, this repo, or chat.**

Lindy Phone numbers are Lindy-managed. Even after a Twilio connect, you
cannot attach Twilio **SMS Received** to the purchased Lindy Phone
line. A working text front door uses a number that the SMS provider
owns.

## Is Twilio → Lindy the right architecture?

**Yes for multi-user inbound SMS to custom Rico. No for the purchased
Lindy Phone line. No for the old OpenClaw SMS funnel.**

The architecture to keep is:

```
approved sender SMS
        │
        ▼
provider-owned SMS number ── inbound trigger ──► Rico on Lindy
        ▲                                            │
        └──────── outbound SMS ◄── existing Rico ────┘
```

Admission stays on the Rico console. Rico never starts a thread.
Strangers fail closed.

Twilio is not a special Lindy design. It is the SMS carrier Lindy
documents for that pair (**SMS Received** + **Send SMS Message**).
Any other inbound-SMS app in the picker is the same shape with worse
docs. Pick Twilio if Alan authorizes a carrier. Do not pick Plivo or
Salesmsg just to avoid saying Twilio.

It is the **wrong** architecture when:

- The goal is “make the purchased Lindy Phone line accept texts.”
  Lindy-managed numbers cannot be hung on a customer Twilio trigger.
  Texting that line will not become Rico SMS by connecting Twilio.
- The goal is “reuse `/webhooks/sms` on Rico.local.” That funnel is
  the old OpenClaw path. It wants the Gateway up. Lindy is the front
  door. Do not aim Twilio at OpenClaw to solve this.
- The only texter is Alan, and he is willing to use the default Lindy
  assistant. That is the native Settings → General path. He already
  forbade rebinding it to speak as Rico, so it is not this front door.
- Alan has not authorized a third-party SMS account. Then the right
  move is report-and-wait, not connect.

Webhook Received is the same architecture with more glue: something
still has to own an SMS number and POST into Lindy. It does not avoid
a carrier. It only avoids Lindy’s Twilio OAuth screen.

Cost is honest: the Lindy Phone line stays a voice line they already
pay for. A working text number is a second, provider-owned line.
Do not release the Lindy line to “make room.” Do not buy another
Lindy number.

## Actual working inbound-text design

For a **custom** agent named Rico (not the default assistant):

```
approved sender SMS
        │
        ▼
SMS provider number  ── SMS Received ──► Rico workflow
        ▲                                      │
        │                                      ▼
        └──────── Send SMS Message ◄── existing Rico agent
```

First-class Lindy docs for that pair: **Twilio → SMS Received** plus
**Twilio → Send SMS Message**.

Closest Lindy-native options that still fail the requirement:

- Settings → General iMessage/SMS: default assistant, owner-only
- Webhook Received: Lindy-native trigger, but the SMS still has to come
  from a provider Alan authorizes. Same authorization bar as Twilio.

Plivo / Salesmsg / SMSTools / ClickSend / RingCentral also expose
inbound SMS triggers. They are not better than Twilio for this job.
Prefer Twilio if Alan authorizes a third-party SMS account, because it
is the path Lindy documents as the two-way SMS pair.

Personal Google on Lindy stays allowed. CVS mail/calendar stay on the
Mini MCP bridge already landed in PR 4. This SMS path does not change
that.

## Polar — do this now (no Twilio yet)

1. Open the Rico agent editor. Do not open the default assistant as if
   it were Rico.
2. Confirm Lindy Phone still shows only **Call Received**. Search the
   trigger picker for `SMS`. You should see third-party apps, not a
   Lindy Phone **SMS Received**.
3. Leave Settings → Phone Numbers alone except to confirm the purchased
   line is still there. Dropdown: do **not** click Release.
4. Leave Settings → General Text message service alone.
5. Do not edit Context / Greeting.
6. Ask Alan, in one sentence: authorize connecting Twilio (or refuse).
   Until he says yes, stop.

## Polar — click path after Alan authorizes Twilio

Do this on the **Rico** agent only. Do not put Account SID, Auth Token,
or the Mini bridge token in git, Polar chat, or a PR.

1. Rico editor → **+** or right-click canvas → **Add Trigger**.
2. Search `Twilio` → **SMS Received**.
   Docs: https://docs.lindy.ai/skills/popular-integrations/twilio
3. **Add Account**. Paste SID and Auth Token into Lindy’s secret fields
   only. Pick a **Twilio-owned SMS number**. Do not try to select the
   Lindy Phone line.
4. Enable the trigger filter on the inbound sender. Approved numbers
   come only from the Rico console (OpenClaw vip-directs / Contacts /
   send-guard). Copy from that console into the Lindy filter. Do not
   invent numbers. Strangers fail closed: no reply.
5. Add an **AI Agent** step that uses the existing Rico agent. Do not
   paste a new personality. Rico never starts a thread; it only replies
   when this trigger fired.
6. Add Action → Twilio → **Send SMS Message**.
   - To: the inbound sender from the trigger
   - From: the same Twilio SMS number
   - Body: the agent reply
7. Toggle the workflow on. Save.
8. Owner-phone test: one inbound text must get a Rico reply by SMS.
9. Stranger test: an unlisted number must get no send.
10. Confirm Tasks shows **SMS Received**, not Call Received and not the
    default-assistant thread.

If Alan refuses Twilio, report that and stop. Do not connect Plivo or
Salesmsg as a workaround unless Alan names that provider.

## What this repo encodes

- This runbook.
- `docs/lindy-inbound-sms.example.json` — shape only. Live numbers and
  tokens stay off-git.
- `docs/lindy-inbound-sms-guard.test.mjs` — fails if this folder grows
  phone numbers or secret-shaped strings.

No local speaker. No iMessage. No Gateway. No Rico 2.
