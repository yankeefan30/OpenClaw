# Polar escalation deployment and rollback

The deployed helper source identity is:

- `index.js`: `ec10327d82741c738156e0042556ce57bf565d548ab9573504a1aa14dffd95f5`
- `bench.js`: `80053913ecef410083d7d89605bdec26155cb034752d9a056611f552fadb96df`
- `../RicoEscalationHandoff/result-contract.js`: `d31faadbe0bca130f55822ea8edac10405827ee11ae20e0d0d9bdacf9ad69cdd`
- combined digest runner: `runner-b7af3ac132fa5d8d6d203b27fb395dfeb10b78298e832274820cdac99623bc63.mjs`
- runner file: `c97c3f7ff2a778f907200160eaf3a891d5334d9c6448ebd707b2a889bc774e13`
- compatibility launcher: `f103ec471a2105f2b43ccb5d0b6f5927eeee139c85e545679c7f1a12c9775f6d`
- `mailbox.js`: `0281781f9d6b23a378d0ab5a9c2fe2d67652318dbc526dd0c39b8af32a840f97`
- `probe.js`: `25e8f8ed278659f0891a57a4011e8ee32c72f2a0eb5e3e34fe59a1c1283274e9`
- launch plist: `f6a11486dd998d9fc9bc54ccbe3067149b1ac2986a35edc4fd42be2dada0bacb`

The sole Auto-review allow rule is retained as a narrowly bounded diagnostic
and recovery rule and must be exactly:

> Run /opt/homebrew/bin/node /Users/alan/OpenClawStudio/PolarEscalationBench/runner-b7af3ac132fa5d8d6d203b27fb395dfeb10b78298e832274820cdac99623bc63.mjs with one final argument: next, complete, renew, or defer.

It does not authorize a shell, wildcard, directory, alternate interpreter,
alternate path, or any other argument. The runner independently rejects other
arguments, strips the child environment, re-verifies all three source hashes, and
writes only an owner-private execution receipt. Grok Bot currently returns
`exec_unbound` before starting this runner, so production does not depend on it.
Direct negative checks confirm both an unlisted `status` command and an extra
argument exit nonzero with only `runner_command_invalid`.

Production uses the active `Rico stuck-question escalation` routine with native
read access to only `DISPATCH.json` and native write access to only the existing
`RESULT.json`. The owner-only service is:

- label: `ai.polar.rico-escalation-mailbox`
- plist: `/Users/alan/Library/LaunchAgents/ai.polar.rico-escalation-mailbox.plist`
- command: `/opt/homebrew/bin/node /Users/alan/OpenClawStudio/PolarEscalationBench/mailbox.js watch`

The service is persistent, event-driven with a 30-second retry, and hardened by
umask `077`. It restores an owner-created native result from `0644` to `0600` on
the exact opened inode before content is read. All managed files settle at
regular, owner-owned, single-link `0600` under an owner-only `0700` directory.

Rollback is owner-only and does not require changing Grok Bot's existing Local
Computer setting or disabling Auto-review: turn off only the `Rico
stuck-question escalation` routine, then run
`launchctl bootout gui/501/ai.polar.rico-escalation-mailbox`. Leave all unrelated
rules and settings unchanged. Re-enable with `launchctl bootstrap gui/501
/Users/alan/Library/LaunchAgents/ai.polar.rico-escalation-mailbox.plist`, verify
the service is running and all mailbox files are `0600`, then turn on only that
routine.

The prior digest path is retained as a temporary owner-only compatibility
launcher. It accepts the same four arguments, verifies the exact new runner
file hash above, and delegates without a shell. It is not used by the production
routine and can be removed during a later owner-attended maintenance window.
