# Rico Stuck-Question Escalation Handoff

This plugin exposes exactly one narrow tool, `rico_stuck_question_escalate`, to
the `rico-shared` agent in a live iMessage run. It does not expose paths or
generic file operations.

The bridge has two operations:

- `submit` appends the host-captured visible question, a bounded account of
  what Rico tried, and the completion criteria to the fixed private inbox,
  then keeps the same tool call open while waiting for the matching result.
- `poll` waits for only the outbox record whose collision-resistant request ID
  matches an existing inbox request.

Both operations poll every two seconds for the first 30 seconds and every five
seconds thereafter, for at most 35 minutes. They honor the host AbortSignal
immediately. A wait cap does not close or invalidate the request: it returns a
retryable pending status, so a later eligible turn can continue the same exact
request without fabricating an answer.

Automatic IMT/current-status callers use the store directly with
`submitWithId(...)` and the host-fixed
`resultContract: "imt-current-status/v1"`. The supplied request ID must match
the normal collision-resistant Rico ID format. Repeating the same ID with the
same sanitized request is idempotent. A private `O_EXCL` lock serializes
concurrent calls across module copies and processes; changing any bound field
for that ID fails closed. The marker is
written to the inbox and makes the structured result fields mandatory for that
request. Generic tool submissions omit it and retain the legacy result shape.

The structured contract in `result-contract.js` carries
`resultContractVersion`, `observedAt`, `sourceClass`, and
`publicCitations`. Legacy or malformed content produces only a host-authored
neutral reply. Polar is a research worker, not a trusted host attestor, so
`official_live` is rejected and can never become an official-current reply.
Fresh public authoritative/secondary material is rendered only behind a fixed
caveat. Each automatic render is a frozen, hash-bound proof with one exact `Rico: ` prefix;
`validateCurrentStatusRender` recomputes the text and hash before dispatch.

The fixed handoff is:

- `/Users/alan/Documents/Codex/rico-escalate/INBOX.md`
- `/Users/alan/Documents/Codex/rico-escalate/OUTBOX.md`

The directory must be owned by the current user with mode `0700`. Both files
must be regular, single-link files owned by the current user with mode `0600`.
Symlinks, hard links, mode drift, oversized files, malformed IDs, ambiguous
records, sensitive content, and mismatched outbox records fail closed.
Each shared request also carries a one-way audience-scope digest bound to the
exact session and sender; a result cannot be polled from another conversation.
The separate `authorized_any_local_group` audience label is accepted only as a
request/result boundary for the signed local-group adapter; it does not imply
recipient-list approval and grants no general messaging authority.
Approved direct use requires the host's trusted owner bit to be explicitly
false. Owner-direct Rico remains outside this shared bridge.

The plugin does not contact Polar, send a message, operate a browser, read any
other file, or grant cross-channel authority. A separate Polar/COS watcher is
still required to turn an inbox request into an outbox result.

The tool definition is registered statically so OpenClaw's catalog and local
model adapters can resolve its advertised name without sender fields that are
not present during catalog construction. Static registration grants no
authority: every execution must atomically consume the exact one-shot tool-call
capability minted by the recipient guard, including its agent, session, sender,
audience, and raw-question proof. Missing or mismatched proof fails closed.

Runtime enablement requires all of the following:

1. Add `rico-escalation-handoff` to `plugins.allow` and enable its plugin entry.
2. Add `rico_stuck_question_escalate` to the `rico-shared` tool allowlist and
   its exact sender policies.
3. Add an exact recipient-guard branch for this tool. That branch must re-prove
   the run-bound sender context, the raw inbound body isolated at
   `before_agent_run`, and the current approved direct/group audience, then
   mint the process-local single-use
   `rico-recipient-guard/escalation-origin/v1` capability. It must not use a
   wildcard or weaken the existing default deny.

Do not enable the plugin until step 3 is present and tested.
