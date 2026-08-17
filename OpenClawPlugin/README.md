# Rico Recipient Guard

Outbound security is one product: **do not text unknown numbers**. Approved,
trusted, owner, and already-`allowFrom` people always send. Missing grants,
policy-read throws, quiet hours, and `event.to` chat_id mismatches must not
drop a send to someone already on the list. Strangers still fail closed.

Direct iMessage turns are private one-to-one conversations. They are not a
shared public-safe group. Rico answers or escalates through the stuck-question
mailbox. He never says “ask Alan directly.” VIP directs start Claude via
`rico-vip-route`. `Model Fallback:` / timeout telemetry is stripped or
cancelled before iMessage delivery.

Inbound still ignores unknown senders. Quiet hours no longer apply to
approved/trusted/owner people. Owner grants may still be consumed so leftovers
do not linger; they are never required.

Guard 0.5.8 is the thin-repair contract. See `docs/RICO_BRINGUP.md`.

For each admitted iMessage turn, the guard binds the exact sender to the
Gateway run ID and injects a minimal trusted sender block before prompt build.
The model receives only the reviewed Contacts display name, access tier, and
whether Alan is the current speaker; exact phone/email handles remain hidden.
Ambiguous names remain unresolved, and a run without correlated sender context
is blocked before model execution. Group membership is read back from Messages
before inbound processing and again before delivery; any change pauses that
group until it is explicitly reviewed in Studio.

Approved VIP directs receive a private one-to-one system prompt. Group turns
still receive a fully replaced public-only system prompt. Shared audiences are deny-all except that one exact
reviewed owner in one exact approved group may receive the single
`rico_group_email_execute` tool after current group membership, private
profile state, and Outlook health are all re-proved. The tool accepts opaque
profile IDs and literal named To/Cc roles only; group membership never becomes
an email recipient list. Every other tool and sender remains deny-all. The guard verifies the
host-applied system prompt and unchanged user prompt again immediately before
model execution. It also binds the Gateway session ID to a SHA-256 audience
fingerprint in `rico-sender-session-attestations.json`; owner and shared
audiences can never reuse one another's session. An old transcript or a changed
group audience is blocked until the supported `sessions.reset` path
creates a fresh session. Optional group personality text is style-only,
canonicalized, and inserted inside this public boundary; it cannot grant tools,
change recipients, or reveal private context.

One narrower, non-authorizing context seam exists for the exact reviewed Jeff
direct principal. When the separately disabled-by-default ISTS workflow is
enabled and its private grant plus read-only adapters pass their current
preflight proofs, the guard asks its context provider for a source-free incident
summary before building Jeff's prompt. The hook requires correlated run,
message, and sender identities; a name match is never accepted. The returned
section grants no tool or action, stays inside the same public/shared prompt,
and explicitly forbids naming chats, mailboxes, recordings, Colleague Zone,
ServiceNow, or AI Insights. Missing correlation, re-auth, source drift, adapter
failure, or an unproven result injects no context.

Studio stores the support directory with mode `0700`, policy files with mode
`0600`, and owner grants as separate atomic files containing only the target,
SHA-256 of the exact message, and expiry. No grant contains message plaintext.
Group-email authority is held only in memory and is atomically bound to the
Gateway run ID and tool-call ID, then consumed once before Outlook preflight.
The group-email definition is registered statically for reliable tool-catalog
resolution, but only an exact verified owner/group `before_tool_call` can mint
that execution grant; owner-direct, non-owner, and unproved calls remain
blocked.

Guard 0.5.8 also applies a deterministic last-mile iMessage filter to the
escalation handoff's exact `rico_<timestamp>_<digest>` request IDs, fixed tool
name, and complete internal result envelopes. Matching content is replaced by
a short provider-neutral verification reply before recipient enforcement.
Ordinary uses of words such as “pending,” “research,” or “request ID” do not
match this filter.

Bounded “what is IMT/Command Center seeing now?” questions take a deterministic
pre-dispatch path after the same exact inbound policy and live group-membership
checks. Owner-direct use is confined to the authenticated
`agent:main:imessage:direct:*` route; approved direct/group use is confined to
the matching `rico-shared` route, with a literal-leading `@rico` required in a
group. Only `event.content` is exported, with host-fixed research criteria and
the request-scoped `imt-current-status/v1` contract. URLs, email addresses,
instruction-shaped suffixes, stale events, route mismatches, and audience
drift fail closed. The adapter waits at most 90 seconds, re-reads policy and
live membership before delivery, and emits only a source-safe, hash-validated
reply carrying one `Rico: ` attestation. Duplicate events are silent; timeout
and transport failures become terminal so no later background answer can
cross the originating response boundary.

Install and restart:

```bash
openclaw plugins install --force "/Applications/OpenClaw Studio.app/Contents/Resources/RicoRecipientGuard"
openclaw plugins enable rico-recipient-guard
openclaw config set plugins.entries.rico-recipient-guard.hooks.allowConversationAccess true
openclaw config set plugins.entries.rico-recipient-guard.hooks.allowPromptInjection true
openclaw plugins install --force "/Applications/OpenClaw Studio.app/Contents/Resources/RicoVipRoute"
openclaw plugins enable rico-vip-route
# Polar brings the gateway up only after QA. See docs/RICO_BRINGUP.md.
```

After restart, `rico.recipient.status` (operator.read) reports only the guard
version, hook/tool contract, policy schema, pause state, and enforcement health. It
never returns identities or message content. Studio requires this live proof,
both hook permissions, isolated DM session scope, and native deny-all policy
read-back before it displays enforcement as verified.
