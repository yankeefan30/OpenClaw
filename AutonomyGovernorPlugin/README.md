# Rico Autonomy Governor

Gateway-authoritative, fail-closed enforcement for versioned Mission contracts. It never schedules work or activates a mission automatically. New state starts globally paused with zero active missions.

- Modes: `shadow`, `suggest`, `bounded`; no unrestricted/trusted mode.
- Shadow allows only declared reads and never write/external tools or outbound delivery.
- Bounded actions require a durable `before_agent_run` run binding. Unknown tools, invalid policy, pause, duplicate intents, budgets, and enforced time windows block.
- Unbound interactive owner/Rico traffic is not claimed; existing recipient policy stays authoritative.
- State is atomically replaced in a `0700` directory with `0600` files. The append-only JSONL ledger is SHA-256 hash chained and restart-verified.
- `missions.advance` durably records Observe → Plan → Policy → Execute → Verify → Complete/Escalate; it executes nothing.

Installed non-bundled use requires `plugins.entries.rico-autonomy-governor.hooks.allowConversationAccess=true`. Bounded activation is rejected until that enforcement boundary and private state are healthy.

Read RPCs use `operator.read`: status, mission list/get, events, evaluate. Upsert/activate/pause/resume/advance and global pause/resume use `operator.admin` and require idempotency keys.

Run `npm test && npm run check`. Tests use isolated temporary directories and never install/configure the plugin, start a Gateway, or send messages.
