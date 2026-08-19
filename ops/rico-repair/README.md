# Rico 2 LAN repair hop

Isolated ops kit for **Rico 2**. Goon copies this directory onto Rico 2.

This is **not** an OpenClaw feature, plugin, second gateway, speaker, or
iMessage path. It does not change chat, VIP, escalate, or Qwen routing.
Polar's cloud box is off the LAN. Rico 2 is on it. The hop SSHes to original
Rico, checks a short allowlist, and can restart Grok Bot / kickstart the
already-installed OpenClaw gateway / conservatively reopen Bionic if the local
model process is dead.

Do not install OpenClaw, Messages, Lindy, or Hermes on Rico 2 for this.

## Machines (fixed)

| Role | LocalHostName | LAN | Tailscale | User |
| --- | --- | --- | --- | --- |
| Target | `Rico` (exact) | 192.168.4.118 | 100.98.73.107 | alan |
| Hop | `Rico-2` | 192.168.4.246 | 100.73.16.116 | alan |

Every remote command hostname-gates: `scutil --get LocalHostName` must be
`Rico`. The kit refuses Rico-2, AlanLTE, and anything else. The hop CLI
refuses to run unless the hop host is `Rico-2`.

## Copy paths

On **Rico 2**:

```
/Users/alan/ops/rico-repair/                 # this directory
/Users/alan/ops/rico-repair/bin/rico-repair  # CLI
/Users/alan/Library/LaunchAgents/ai.polar.rico-repair.plist
~/Library/Logs/rico-repair.log
~/Library/Logs/rico-repair-alert          # current ALERT copy Goon can open
~/.local/state/rico-repair/ALERT          # flag file; present only when last tick was bad
~/.config/rico-repair/state
```

**Polar stays off Rico 2.** Polar's job is original Rico only (`authorized_keys` + optional kit). Goon owns this hop, the CLI, and the LaunchAgent on Rico 2.

On **Rico** (Polar lands this; hop calls it by name):

```
/Users/alan/Library/Scripts/rico-repair-kit.sh
```

If the kit is missing, the hop falls back to the bundled kit over SSH stdin,
then to a tiny inline allowlist (`identity`, `probe-healthz`,
`restart-gateway`, `grokbot-status`, `probe-lmstudio`, `disk`). It never sends
a free-form remote shell string.

## SSH key (Rico 2 → Rico)

On **Rico 2**, as alan, generate an ed25519 key with **no passphrase**. Do not
put a login password in any file.

```sh
mkdir -p ~/.ssh
chmod 700 ~/.ssh
ssh-keygen -t ed25519 -f ~/.ssh/rico2-to-rico -N '' -C 'rico2-to-rico'
chmod 600 ~/.ssh/rico2-to-rico
chmod 644 ~/.ssh/rico2-to-rico.pub
```

Show Polar **only the fingerprint**, never the private key and never a dumped
authorized_keys file:

```sh
ssh-keygen -lf ~/.ssh/rico2-to-rico.pub
ssh-keygen -E sha256 -lf ~/.ssh/rico2-to-rico.pub
```

Expected algorithm: ED25519. Polar compares that fingerprint after landing the
public key on Rico.

## What Polar must land on Rico

Polar does this on **original Rico only**. Polar does not log into Rico 2 and does not load the LaunchAgent.

1. **authorized_keys** — append the **public** key line from Rico 2
   (`~/.ssh/rico2-to-rico.pub`). Suggested options (still allows `ssh host cmd`):

   ```
   from="192.168.4.246,100.73.16.116",restrict <paste-public-key-line>
   ```

   `restrict` blocks forwarding/PTY extras. Do not add a password. Do not
   commit the public key to git. Confirm the fingerprint Polar received matches
   `ssh-keygen -lf` on Rico 2.

2. **Kit** (recommended):

   ```sh
   mkdir -p /Users/alan/Library/Scripts
   install -m 700 kit/rico-repair-kit.sh /Users/alan/Library/Scripts/rico-repair-kit.sh
   /Users/alan/Library/Scripts/rico-repair-kit.sh identity
   ```

   The kit must print `host=Rico` and exit 78 on any other LocalHostName.

3. Seed `known_hosts` on Rico 2 **before** loading launchd (BatchMode will
   otherwise fail on an unknown host key):

   ```sh
   ssh -i ~/.ssh/rico2-to-rico -o IdentitiesOnly=yes alan@192.168.4.118 true
   ssh -i ~/.ssh/rico2-to-rico -o IdentitiesOnly=yes alan@Rico.local true
   ssh -i ~/.ssh/rico2-to-rico -o IdentitiesOnly=yes alan@100.98.73.107 true
   ```

SSH tries targets in this order: `192.168.4.118`, `Rico.local`,
`100.98.73.107`. Options: `BatchMode`, `ConnectTimeout 8`, `IdentitiesOnly`,
key `~/.ssh/rico2-to-rico`. Password auth is off.

## CLI

On Rico 2:

```sh
/Users/alan/ops/rico-repair/bin/rico-repair status
/Users/alan/ops/rico-repair/bin/rico-repair restart-gateway
/Users/alan/ops/rico-repair/bin/rico-repair restart-grokbot
/Users/alan/ops/rico-repair/bin/rico-repair watch-once
/Users/alan/ops/rico-repair/bin/rico-repair watch          # foreground loop
/Users/alan/ops/rico-repair/bin/rico-repair self-check     # no SSH
```

`wake-desktop` is an alias of `restart-grokbot` (Goon v1 name). Manual restart
commands do not use the 10-minute cooldown. The scheduler does.

## Monitor / LaunchAgent (Goon, Rico 2 only)

Goon loads this LaunchAgent on **Rico 2**. Polar does not. Shape: one-shot
`watch-once` every **10 minutes** (`StartInterval = 600` + `RunAtLoad`). No
KeepAlive loop, no sockets, no `0.0.0.0` bind, no cloud relay, no mail, no
iMessage.

Each tick checks original Rico through the hop (hostname-gated):

- gateway `http://127.0.0.1:18789/healthz` (expect `live`)
- Grok Bot desktop process
- Qwen/LM Studio `:1234` process (`llmster` / `127.0.0.1:1234` LISTEN)

**If everything is fine:** log `ok` and do nothing else. No ALERT file.

**If something is off:** write a local ALERT Goon can see, then run this same
`rico-repair` script for the matching action(s):

- `healthz` not `live` → `restart-gateway`
- Grok Bot process missing → `restart-grokbot`
- `:1234` **process dead** → `restart-lmstudio` (Bionic.app only; slow-but-alive is left alone)

ALERT locations on Rico 2 (no network send):

```
~/.local/state/rico-repair/ALERT
~/Library/Logs/rico-repair-alert
~/Library/Logs/rico-repair.log          # line starts with ALERT
```

A later healthy tick removes the ALERT flag files. Cooldown is **10 minutes
per action type** so a still-bad service is not restart-looped. The next tick
still refreshes the ALERT so Goon can see it.

### Load on Rico 2 (Goon)

```sh
plutil -lint /Users/alan/ops/rico-repair/launchd/ai.polar.rico-repair.plist
mkdir -p ~/Library/LaunchAgents
cp /Users/alan/ops/rico-repair/launchd/ai.polar.rico-repair.plist \
  ~/Library/LaunchAgents/ai.polar.rico-repair.plist
launchctl bootout "gui/$(id -u)/ai.polar.rico-repair" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/ai.polar.rico-repair.plist
launchctl kickstart "gui/$(id -u)/ai.polar.rico-repair"
```

Do this only after `status` works. Do not load the plist on original Rico.
Polar stays off Rico 2.

### Unload

```sh
launchctl bootout "gui/$(id -u)/ai.polar.rico-repair"
rm -f ~/Library/LaunchAgents/ai.polar.rico-repair.plist
```

Leave the OpenClaw gateway, Grok Bot, and iMessage stack untouched.

## Test without mail or iMessage

These commands never send Messages, Mail, Outlook, or `openclaw --deliver`:

```sh
/Users/alan/ops/rico-repair/bin/rico-repair self-check
/Users/alan/ops/rico-repair/bin/rico-repair status
/Users/alan/ops/rico-repair/bin/rico-repair watch-once
tail -n 50 ~/Library/Logs/rico-repair.log
test -f ~/.local/state/rico-repair/ALERT && cat ~/.local/state/rico-repair/ALERT
cat ~/.config/rico-repair/state
```

`status` should show `host=Rico`, `healthz=live` or `down`, Grok Bot
running/missing, and `lmstudio_alive`. A healthy `watch-once` only logs `ok`.
A bad tick writes the ALERT flag, then runs the matching command if cooldown
allows. There is no speaker.

Repo check (any host with bash):

```sh
ops/rico-repair/tests/check.sh
```

## Grok Bot / Bionic discovery

The kit looks for an exact **Grok Bot.app** (pin, `/Applications`,
`~/Applications`, then `mdfind` on that filename). It will not launch
`Cursor.app` or invent a bundle id. If more than one candidate exists, it
logs them and refuses.

Pin on Rico if needed:

```
~/.config/rico-repair/grokbot-app     # one line, e.g. /Applications/Grok Bot.app
~/.config/rico-repair/lmstudio-app    # one line, e.g. /Applications/Bionic.app
```

Examples: `examples/grokbot-app.example`, `examples/lmstudio-app.example`.

LM Studio hypothesis used here: **Bionic.app** hosts the local server;
**llmster** listens on `127.0.0.1:1234`. Verify on Rico before the first
reopen. Do not restart a healthy slow model.

## Allowlisted Rico actions

- identity / uptime
- `caffeinate -s -t 180` if no `-s` assertion is present (no `pmset` writes)
- `curl -sS -m 5 http://127.0.0.1:18789/healthz` (expect `live`)
- if healthz is down: `launchctl kickstart -k gui/501/ai.openclaw.gateway` then re-probe
- `curl -sS -m 5 http://127.0.0.1:1234/v1/models`
- conservative Bionic reopen only when the local server process is dead
- read `/Users/alan/Documents/Codex/rico-comms-monitor/state.json` if present (safe keys only)
- Grok Bot quit/open
- `df -h /`

## Forbidden (always)

- iMessage / imsg / Messages send
- Outlook / Mail send
- `openclaw --deliver`, resume autonomy, mutate missions
- dumping `~/.openclaw/openclaw.json`, `~/.codex/auth.json`, Keychain, `chat.db`, phone numbers
- reboot of either Mini
- disable SIP
- binding `0.0.0.0`
- installing OpenClaw / Messages / Lindy / Hermes on Rico 2
- putting a login password in any script
