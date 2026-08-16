# OpenClaw Studio capability matrix

Detected protocol baseline: OpenClaw Gateway protocol v4, local loopback Gateway. Capabilities are intentionally classified from the installed documentation and current client surface.

| Area | Capability | Status | Notes |
|---|---|---|---|
| Automations | `cron.status`, `cron.list`, `cron.get`, `cron.runs` | Supported | Read-only scheduler and run history |
| Automations | `cron.run` | Supported | Tracks returned `runId` through `cron.runs` terminal state |
| Automations | `cron.add`, `cron.update`, `cron.remove` | Supported | Strict proposal parsing plus explicit operator review; new jobs default disabled |
| Channels | `channels.status` | Supported | Credentials are never rendered |
| Channels | start/stop/login | Deferred | Channel-specific methods are not globally documented; no invented generic controls |
| Channels | `channels.logout` | Read-only | Discovery exists; UI remains disabled until channel support is confirmed |
| Nodes | `node.list` | Supported | Capabilities and last-seen metadata |
| Nodes | `node.describe` | Deferred | Detail RPC wiring pending schema-specific view |
| Nodes | invocation | Deferred | Explicitly withheld from first release |
| Devices | `device.pair.list` | Supported | Pending/paired inventory |
| Devices | approve/reject/rename/remove | Deferred | Pairing mutation payloads require schema-specific confirmation UI |
| Models | `models.list(view: configured)` | Supported | Read-only configured catalog |
| Models | auth status | Read-only | Status only, never secret values |
| Models | model selection/fallback updates | Deferred | No safe schema-validated update surface exposed |

## Mission autonomy boundary

Studio 1.1 adds a Gateway-native authority boundary around eligible OpenClaw agent,
tool, and messaging activity. Scheduling, Workboard, and TaskFlow remain separate
OpenClaw ledgers. The Swift app is a review and observability client; it is not the
authority for autonomous execution.

| Layer | Responsibility | Authority |
|---|---|---|
| Mission builder | Compile natural language into a strict inactive contract | Proposal only |
| Mission Control | Review, display health/events, request lifecycle mutations | Operator client |
| Autonomy Governor | Persist policy/counters, bind runs, enforce hooks, audit | Gateway authority |
| Cron / heartbeat / webhook | Produce reviewed wake events | Trigger only |
| Workboard / TaskFlow | Track plans, claims, work, and evidence | Separate execution ledgers |
| Completion checkpoint | Require recorded evidence before `complete` | Governor evidence gate |
| Independent verifier | Compare artifacts with success criteria | Deferred |

The governor starts with global pause enabled and no active missions. Activation and
resume require `operator.admin`, expected-revision protection, an idempotency key,
and a verified Gateway enforcement report. Unknown or legacy unbounded modes are
rejected. A repeated host run ID is suppressed and every tool/message intent has an
idempotency binding; separately generated wake events remain subject to the exact
daily run ceiling and should use the scheduler's own declaration-key discipline.

`Unavailable` is reserved for methods rejected by the installed Gateway. `Deferred` means documented but intentionally not exposed until the live schema and confirmation UX are wired. Permission-denied and partial-failure responses remain visible as Gateway errors rather than being converted into success.
