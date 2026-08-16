# OpenClaw Studio operational inbox threat model

## Scope

Tasks and approvals are a local macOS operator surface for the loopback OpenClaw Gateway. The Console is not the authoritative task or approval ledger. Gateway responses and events are authoritative.

## Assets

- Gateway bearer token and operator scopes
- Approval arguments, which may contain credentials or private data
- Task/session identifiers and operational metadata
- User decisions and Gateway request identifiers

## Trust boundaries

1. OpenClaw Gateway to Console: authenticated WebSocket on loopback. The Console uses documented RPCs and never edits `openclaw.json`.
2. Gateway event stream to UI: events are untrusted data. They are displayed as text and never interpreted as scripts, paths, or commands.
3. Approval arguments to audit/UI: fields matching credential patterns are redacted before rendering or persistence.
4. Local audit display: append-only best-effort evidence for the operator, not a replacement for `audit.activity.list` or the Gateway approval ledger.

## Abuse cases and controls

- **Forged/stale approval:** every decision targets the exact approval ID, uses first-answer-wins Gateway resolution, and refreshes after the RPC. Already-resolved requests are not shown as pending.
- **Double submission:** controls are disabled by state refresh and the Gateway remains authoritative. A second resolve is recorded as the Gateway result, never assumed successful.
- **Dangerous command approval:** deletion, credential access, privilege escalation, system configuration, and broad filesystem signals require an explicit confirmation step. Only approve-once is exposed.
- **Secret leakage:** arguments are sanitized with key/value redaction before display and local audit persistence. Notifications contain only a generic title and approval ID.
- **Cancellation race:** task cancellation is sent with the exact task ID. The UI does not mark a task cancelled unless the Gateway returns `cancelled: true`; a later refresh reconciles the task ledger.
- **Reconnect replay:** approval events are treated as hints, followed by a fresh pending-list reconciliation. Duplicate notifications must not be treated as duplicate approvals.
- **Remote content execution:** transcript/task/approval text is rendered as text or Markdown only. The app does not load arbitrary URLs, execute scripts, or open local paths from payloads.
- **Notification misuse:** macOS notifications open the approval item through `approvalID` routing only; they never include Approve/Reject actions.
- **Overbroad authority:** the client requests explicit operator scopes and fails closed on unsupported approval RPCs. No permanent allowlist editor is present.
- **Mission metadata tampering:** reviewed mission contracts are sent to the
  Gateway governor and returned with revision and policy hashes. Studio's local
  presentation state is never treated as execution authority. Workboard cards,
  runs, evidence, and mission events remain Gateway-authoritative.
- **Policy confusion:** the legacy local objective evaluator and ungoverned
  Workboard dispatch path cannot authorize execution. Studio shows enforcement as
  verified only when the Gateway governor reports a healthy matching contract and
  registered hooks. Shadow, Suggest, and Bounded are the only supported modes.
- **Unbound execution:** autonomous runs, tool calls, and outbound messages without
  an active mission binding fail closed at the Gateway hooks. Display names, prompt
  claims, and model output cannot manufacture mission authority.
- **Budget or replay bypass:** the governor uses expected revisions, idempotency
  keys, durable counters, exact mission/run bindings, and an append-only
  hash-chained ledger. Unknown action categories and exhausted ceilings block.
- **Wake duplication:** Studio owns no scheduler or timer. Durable wake must come
  from the configured OpenClaw heartbeat or cron system, and repeated dispatches
  rely on Gateway idempotent claims and Workboard selection rules.
- **Emergency stop boundary:** Mission Control presents pause only after the
  Gateway confirms the restrictive mutation. Global pause prevents new governed
  work; it does not claim to terminate unrelated processes or erase already-sent
  side effects.

## Residual risks

- A compromised local user account can access the same loopback Gateway and may read the local audit file.
- The Console’s local audit file can be deleted or modified by the local account. Use the Gateway audit ledger for authoritative investigations.
- Approval risk classification is heuristic and supplemental. Operators must review the exact Gateway-provided operation and arguments.
- The autonomy governor prevents new governed work but cannot retroactively undo a
  completed external side effect. Operators must still use the relevant service's
  recovery controls when a provider accepts an action before a pause arrives.
- Workboard and cron remain separate installed OpenClaw ledgers. A mission contract
  does not silently create a schedule or dispatch a card; those mutations require
  their own reviewed, schema-validated operation.

## Rico communications boundary

Rico uses stable normalized sender identifiers as the authentication input.
Display names, message text, quoted text, attachments, conversation history,
and claimed identity are never authentication factors. Owner identities are
configured explicitly; unknown identities can request pairing but cannot
inherit owner authority.

External contacts are capped at relationship or public context. Context is
filtered before model invocation using audience, purpose, sensitivity,
expiration, and quoting metadata. Private email, files, memory, and messages
are not retrieved and then hidden from the model.

Inbound and outbound decisions are deterministic and precede agent execution
or message delivery. Sensitive topics, commitments, scheduling claims,
private-source disclosure, first contact, attachments, low confidence, rate
limits, and global pause fail closed to owner approval, block, or defer.
Rico's model cannot approve its own outbound message.

The Rico registry, policy, personality, workflow definitions, and audit
display are app-managed sidecars under
`~/.openclaw/workspace/rico/`. They are not substitutes for the Gateway
channel, approval, session, or audit ledgers. OpenClaw configuration writes
remain disabled in the setup surface until an exact reviewed schema and
operator confirmation path is implemented.
