# Hedy launch unblock

Isolated ops kit so Alan’s Mac (or Windows PC) can launch the
[Hedy](https://www.hedy.ai) desktop app. This is **not** an OpenClaw feature,
plugin, Gateway path, or Rico policy change. It does not touch SIP, disable
Gatekeeper globally, or alter OpenClaw Studio.

Hedy is the meeting-coach app (hedy.bot / hedy.ai). Alan already signed in on
2026-08-24; the iPhone session works. Desktop launches are what this kit
repairs.

## What blocks launch

On **macOS 15+ / 26 (Tahoe)**, Gatekeeper often:

1. Stamps a downloaded `Hedy.app` with `com.apple.quarantine`.
2. Caches a launch-block against that **inode** (and sometimes the CDHash).
   Clearing xattrs alone is not enough. Overwriting the app in place keeps the
   blocked inode.

On **Windows**, Defender / SmartScreen / McAfee commonly quarantine
`HedySetup-*.exe` or `Hedy.exe` (documented Hedy false positive).

This kit never runs `spctl --master-disable`, `csrutil`, or a reboot.

## Mac (primary)

On the Mac that has Hedy installed:

```sh
ops/hedy-launch/bin/hedy-allow-launch
```

What it does:

1. Finds `Hedy.app` under `/Applications`, `~/Applications`, or a mounted
   official DMG.
2. Confirms the bundle name or identifier refers to Hedy.
3. Copies the bundle to a new inode, strips quarantine, replaces the blocked
   copy, and opens the app.
4. Prints the Microphone and Screen Recording toggles Hedy still needs in
   System Settings → Privacy & Security. Those TCC grants are owner-only; this
   script does not write the TCC database.

Dry-run (safe on Linux CI and on the Mac):

```sh
ops/hedy-launch/bin/hedy-allow-launch --dry-run
ops/hedy-launch/tests/check.sh
```

`--app /path/to/Hedy.app` pins an already-installed bundle. The script refuses
any other `.app`.

After a later Hedy update: delete `/Applications/Hedy.app` first, then install
fresh. Do not overwrite the blocked inode.

## Windows

In an elevated PowerShell on the PC that blocked the installer:

```powershell
ops/hedy-launch/bin/hedy-allow-launch.ps1
```

Restores Hedy from Defender quarantine when present, adds process/path
exclusions for `Hedy.exe` and `%LOCALAPPDATA%\Hedy`, and unblocks a downloaded
`HedySetup-*.exe`. It does not disable real-time protection.

## This cloud Linux box

Hedy has **no native Linux app**. Audio capture needs Mac, Windows, or
mobile. The web companion at https://web.hedy.ai/ can load in Chrome here for
history and sign-in.

Install the managed Chrome policy (already applied on this agent VM):

```sh
sudo mkdir -p /etc/opt/chrome/policies/managed
sudo cp ops/hedy-launch/linux/allow-hedy-chrome.json \
  /etc/opt/chrome/policies/managed/allow_hedy.json
```

That allowlists Hedy hosts for popups, mic/camera capture, notifications, and
Safe Browsing. It does not set `URLAllowlist` (that would block every other
site) and does not weaken Chrome for unrelated hosts.

## What this kit will not do

- Disable SIP, Gatekeeper, or Windows Defender real-time scanning globally.
- Grant macOS Microphone / Screen Recording on Alan’s behalf.
- SSH to Rico. Polar’s cloud box cannot reach `rico.tail434bbe.ts.net`.
- Change OpenClaw, Rico allowlists, or LaunchAgents.
