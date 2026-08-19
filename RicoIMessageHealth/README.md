# Rico iMessage healthcheck

Daily **Messages.app Apple Event** check for **original Rico only** (`Rico.local` / LocalHostName `Rico`). Polar lands two files on that Mac and bootstraps a LaunchAgent that runs at **06:00 America/New_York**, 30 minutes before COS 06:30 Ana/Janet good mornings.

This is not OpenClaw, not the Gateway, not Rico 2, and not a send path. COS morning send uses `imsg`; `imsg` 0.14.1 `send --chat-id` uses AppleScriptSendTransport → `osascript`. If Messages is AE-deaf, nothing is actually sent.

## Why

On 2026-08-19, COS 06:30 good mornings failed on original Rico. Polar's diagnosis (do not re-litigate unless a better cause shows up):

- Messages.app PID 9037 had been up since 2026-08-16 17:04 ET
- The send Apple Event never completed
- Two `/usr/bin/osascript` children each held `appleeventsd` for 120.1s then exited
- `imsg` ProcessTimeout is 150s; the AE wait-for-reply bound is 120s
- TCC Automation of Messages was already allowed; SIP was enabled

Hypothesis this job tests: a long-lived Messages.app wedges the AE handler; a **short read-only AE probe** (`tell application "Messages" to get name`, 12s timeout) detects that, and a **quit/relaunch plus re-probe** restores a live AE path. No probe text. No chat-id. No thread start.

## What Polar copies (two files)

On **original Rico** only. Abort if `hostname` is not `Rico.local`. Do not install on Rico 2 (`Rico-2.local` / 192.168.4.246). Do not clone this repo onto Polar's cloud box to run it; copy from this PR onto Rico.

| File in this PR | Land path on Rico |
| --- | --- |
| `RicoIMessageHealth/polar-imessage-health.zsh` | `/Users/alan/OpenClawStudio/RicoIMessageHealth/polar-imessage-health.zsh` |
| `RicoIMessageHealth/launchd/ai.polar.imessage-health.plist` | `/Users/alan/Library/LaunchAgents/ai.polar.imessage-health.plist` |

The script hostname-gates: if someone copies it to Rico 2 it exits 1 and does nothing (no osascript, no Messages quit, no kills).

## What the script does

1. Exit 1 immediately unless hostname is `Rico.local` **and** `scutil --get LocalHostName` is `Rico`.
2. Record leftover hung `/usr/bin/osascript` processes that are clearly Messages-AE related (argv mentions Messages, or parent is `imsg`) and leftover `imsg` processes whose argv includes the send-subcommand. Kill those in a live run.
3. Confirm Messages.app is running; `open -g -a Messages` if it is not.
4. Probe Apple Events with a **12s** timeout: `osascript -e 'tell application "Messages" to get name'`. Success = AE path is live.
5. Confirm `/opt/homebrew/bin/imsg` exists, is **0.14.1 or later**, and can run a no-send command (`--version`, then `--help`).
6. If the AE probe fails (timeout or error), quit/relaunch Messages (graceful AE quit with a short timeout, then TERM/KILL that Messages PID if it is still up), wait until it is running, re-probe.
7. Write:
   - `/Users/alan/Library/Logs/polar-imessage-health.log`
   - `/Users/alan/Library/Logs/polar-imessage-health.state.json`

Exit 0 = AE live and imsg no-send check passed. Exit 2 = still unhealthy. Exit 1 = wrong host.

### Will not

- Send any iMessage (no `imsg` send-subcommand, no Messages `send`, no chat-id, no Ana/Janet/VIP/owner probe text)
- Disable SIP, reset TCC, click permission dialogs, or reboot Rico
- Restart OpenClaw / the Gateway (COS uses `imsg`; if AE is still dead after relaunch the blocker is Messages, not the Gateway)
- Touch Rico 2, chat.db, Keychain, tokens, phone numbers, or `allowFrom`

## Land on original Rico

SSH or sit at Alan's Mac mini (`ComputerName` Alan's Mac mini, LAN `192.168.4.118`).

```sh
# 1. Prove this is original Rico. Stop if it is not.
hostname            # must print Rico.local
scutil --get LocalHostName   # must print Rico
scutil --get ComputerName    # Alan's Mac mini
# If you see Rico-2 / Rico-2.local / 192.168.4.246, abort.

# 2. Copy the two files from this PR.
install -d -m 0755 /Users/alan/OpenClawStudio/RicoIMessageHealth
install -m 0755 polar-imessage-health.zsh \
  /Users/alan/OpenClawStudio/RicoIMessageHealth/polar-imessage-health.zsh
install -m 0644 launchd/ai.polar.imessage-health.plist \
  /Users/alan/Library/LaunchAgents/ai.polar.imessage-health.plist

# 3. Dry-run once (read-only AE probe; no kill / no quit / no relaunch).
/bin/zsh /Users/alan/OpenClawStudio/RicoIMessageHealth/polar-imessage-health.zsh --dry-run
cat /Users/alan/Library/Logs/polar-imessage-health.state.json
tail -n 5 /Users/alan/Library/Logs/polar-imessage-health.log

# 4. Bootstrap the 06:00 ET agent. Do not RunAtLoad; the calendar interval is the schedule.
UID_NUM="$(id -u)"
launchctl bootout "gui/${UID_NUM}/ai.polar.imessage-health" 2>/dev/null || true
launchctl bootstrap "gui/${UID_NUM}" /Users/alan/Library/LaunchAgents/ai.polar.imessage-health.plist
launchctl enable "gui/${UID_NUM}/ai.polar.imessage-health"
launchctl print "gui/${UID_NUM}/ai.polar.imessage-health" | head
```

Rico's **system timezone must stay America/New_York** so LaunchAgent `StartCalendarInterval` 06:00 is 06:00 ET.

Optional, if Messages is currently wedged and you do not want to wait until 06:00: run the script **without** `--dry-run` once. That is the same remediation the agent will do at 06:00 (quit/relaunch Messages if the 12s AE probe fails). Still no send.

```sh
/bin/zsh /Users/alan/OpenClawStudio/RicoIMessageHealth/polar-imessage-health.zsh
```

## Dry-run vs live

| | `--dry-run` | live (agent / no flag) |
| --- | --- | --- |
| Hostname gate | yes | yes |
| Read-only AE `get name` | yes | yes |
| `imsg --version` / `--help` | yes | yes |
| Kill hung osascript / imsg send-subcommand | no (records `would_kill_*`) | yes |
| Quit/relaunch Messages | no (`would_relaunch_messages`) | yes, only if AE failed |
| Restart OpenClaw | never | never |
| Send iMessage | never | never |

## QA in this repo (no live send)

```sh
cd RicoIMessageHealth
npm test
```

Tests mock hostname, `osascript`, process table, and `imsg`. They never talk to Messages.app. They prove hostname abort, AE success, AE-timeout → relaunch, leftover-osascript cleanup, Mail osascript left alone, and the no-send invariant.

## Uninstall

```sh
UID_NUM="$(id -u)"
launchctl bootout "gui/${UID_NUM}/ai.polar.imessage-health" 2>/dev/null || true
rm -f /Users/alan/Library/LaunchAgents/ai.polar.imessage-health.plist
# Leave the log/state files unless you want them gone:
# rm -f /Users/alan/Library/Logs/polar-imessage-health.log \
#       /Users/alan/Library/Logs/polar-imessage-health.state.json
```
