# Rico disk cleanup (Polar playbook)

Polar (or a local Cursor/Codex session) must run this **on original Rico**, the Mac mini whose `LocalHostName` is `Rico` and hostname is `Rico.local`. This cloud/GitHub workspace cannot see Rico’s disks. A GitHub-only cleanup that never runs here does not free the 460GB internal APFS volume.

Repo search on 2026-08-25 found **no existing Polar disk-cleanup notes**. This package is the playbook.

Do not run this on Rico 2 or a MacBook. Do not apply Lindy work. Do not touch iMessage send paths.

## Run on Rico

From `/Users/alan/OpenClawStudio`:

```sh
zsh RicoDiskCleanup/rico-disk-cleanup.zsh --self-test
zsh RicoDiskCleanup/rico-disk-cleanup.zsh --dry-run
zsh RicoDiskCleanup/rico-disk-cleanup.zsh --apply
```

`--dry-run` is the default. `--audit-only` writes sizes and does not clear or move. `--apply` performs only the safe actions below.

The script aborts unless `scutil --get LocalHostName` is exactly `Rico` and `hostname` is `Rico` / `Rico.local`. It also aborts on Rico 2 / MacBook identity strings and if the user is not `alan`.

## Safe vs Alan OK

### Safe for Polar to do without a new ask

- Host-gate, then `du` the usual hogs (Caches, Logs, Downloads, Documents, Movies, CloudStorage, LM Studio, Messages **size only**).
- Delete regenerable user caches under `~/Library/Caches`, except protected names.
- Thin **local** Time Machine snapshots (`tmutil thinlocalsnapshots` only). Does not add a TM destination.
- Copy-then-verify-then-remove leftover `*.dmg` / `*.pkg` / `*.iso` from `~/Downloads` and `~/Desktop` into dated overflow:

  `/Volumes/Movie Drive/Rico-Overflow/YYYY-MM-DD/installers/`

  Same-hash dest + leftover source is treated as already moved (idempotent). Different-hash dest is a hard refuse — never overwrite.

### Hard no (script skips or aborts)

| Leave on Rico internal disk | Why |
| --- | --- |
| `/Applications/Littlebird.app` | Alan: Littlebird stays local |
| `~/Library/Application Support/Littlebird` | Alan: Littlebird stays local |
| `~/Library/Application Support/ContextKit` | Littlebird/ContextKit stack |
| Anything named **Hedy** (app, support, models, LaunchAgents, OpenClaw/Hedy paths, installers) | Alan: Hedy stays local |
| `~/Library/Messages/chat.db` and the Messages folder | Secrets / history |
| `~/Library/Keychains`, `~/.ssh`, `~/.gnupg`, `*.pem` / `*.p12` / tokens | Secrets |
| LM Studio / Qwen `*.gguf` models under `~/.lmstudio` or LM Studio app support | Keep on internal unless Alan later marks an unused duplicate |
| Existing files on Movie Drive (the ~2021 movie library) | Do not overwrite movies |
| Movie Drive format / HFS→APFS / erase / partition | Polar confirmed volume is in use |
| SIP (`csrutil disable`) or reboot | Alan did not ask |
| Time Machine onto this HFS Movie Drive | Optional and **off**. HFS + mixed movie library is a bad TM target. Overflow/archive only. |

### Needs Alan OK before anyone moves them

- `~/Documents`
- Google Drive / `~/Library/CloudStorage`
- Movie files (`.mp4` / `.mov` / `.mkv` and the library already on Movie Drive)
- LM Studio / Qwen models, even suspected unused duplicates
- Xcode DerivedData, Docker, iOS backups, Photos, Mail
- Emptying Trash if it might contain Littlebird/Hedy
- Any Time Machine destination change

Caches for **other** apps may still be cleared. Overflow is only for installers / old disk images / clearly safe leftovers that are **not** Littlebird or Hedy.

## How to tell it is done

On Rico, compare before/after in the written report (also printed at the end of the run):

```sh
df -h /System/Volumes/Data
df -h "/Volumes/Movie Drive"
```

Report path on Rico:

`~/Library/Logs/rico-disk-cleanup/report-<YYYYMMDDTHHMMSS>.txt`

On `--apply`, a copy is also written under `/Volumes/Movie Drive/Rico-Overflow/<date>/reports/` when the G-DRIVE is mounted.

Done means: host gate passed, SIP unchanged, Movie Drive still HFS “Movie Drive” with the old movie library intact, Littlebird/Hedy still on the internal disk, and the report shows `df` before/after plus `moved=` / `cleared_cache_entries=` / `skipped_protected=`.

## Facts Polar already confirmed (2026-08-25 ~6:17 a.m. ET)

- Internal APFS Data: ~460GB volume, ~400GB used, ~41GB free (~91%).
- External: `disk6`, 4.0 TB G-DRIVE (Thunderbolt USB 3.0), HFS volume name **Movie Drive**, mounted at `/Volumes/Movie Drive`, ~1.8TB used / ~1.8TB free. Media HGST HDS724040ALE640. Volume since ~2021 (movies).
- Polar’s host is original Rico only.

## Self-test (this repo / Polar before apply)

```sh
zsh RicoDiskCleanup/rico-disk-cleanup.zsh --self-test
```

Uses a temp fixture. It does not touch Rico’s real disks. It proves the Rico 2 / MacBook abort, Littlebird/Hedy skip, copy-verify-remove, and “do not overwrite movies” rules.
