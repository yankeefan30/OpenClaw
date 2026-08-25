# Rico disk cleanup (Polar playbook)

Polar (or a local Cursor/Codex session) must run this **on original Rico**, the Mac mini whose `LocalHostName` is `Rico` and hostname is `Rico.local`. This cloud/GitHub workspace cannot see Rico’s disks. A GitHub-only cleanup that never runs here does not free the 460GB internal APFS volume.

Repo search on 2026-08-25 found **no existing Polar disk-cleanup notes**. This package is the playbook.

Optimize for **Rico performance**. The internal APFS volume is the SSD working set. The 4TB G-DRIVE (Movie Drive, HGST HDS724040ALE640, spinning SATA behind Thunderbolt) stays connected and is fine for sequential overflow. Alan may later buy a USB4/Thunderbolt SSD for faster overflow — that is a **path change** in `overflow-target.zsh`, not a redesign.

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

## Performance placement

| Lives on internal SSD (do not move) | Why |
| --- | --- |
| Littlebird + ContextKit (app, Application Support, caches) | Alan-locked; latency-sensitive |
| Anything named Hedy (app, support, models, LaunchAgents, OpenClaw/Hedy) | Alan-locked; latency-sensitive |
| Qwen / LM Studio models, `~/.lmstudio`, LM Studio Application Support | Random I/O; keep local |
| llmster | Random I/O; keep local |
| `/Applications` and `~/Applications` (the apps themselves) | Launch path |
| Messages / `chat.db`, Keychain, secrets | Do not touch |
| Active app caches needed for snappy launch | Do not wipe or overflow |
| VM swap (`/var/vm`, swapfiles) | Latency-sensitive |
| OpenClaw / Cursor / Codex working trees and app support if in the daily set | Active random I/O |
| Any other random-I/O or latency-sensitive tree | Stay on SSD |

| OK on Movie Drive (HDD overflow) today | Notes |
| --- | --- |
| Old installers, `*.dmg` / `*.pkg` / `*.iso` | Copy-verify-remove from Downloads/Desktop |
| One-shot archives (`*.zip` / `*.tar` / `*.tgz` / `*.7z`) from Downloads/Desktop | Same verify path; skip if the name is Littlebird/Hedy/model/working-tree |
| Cold documents/media not in the daily working set | **Alan OK** before Polar moves them |
| Copies of bulky unique data after verify, if not performance-critical | **Alan OK**; never delete the only copy first |

Do **not** put Time Machine on this HFS movie volume. Do **not** relocate Application Support for Littlebird, Hedy, or LM Studio — not onto Movie Drive, and not onto a future overflow SSD either.

## Safe vs Alan OK

### Safe for Polar to do without a new ask

- Host-gate, then `du` the usual hogs (Caches, Logs, Downloads, Documents, Movies, CloudStorage, LM Studio, llmster, OpenClawStudio, Messages **size only**).
- Delete **leftover installer caches only** (today: Homebrew downloads / leftover `.dmg`/`.pkg` under `~/Library/Caches`). Leave Safari, Cursor, Littlebird, Hedy, and other launch caches on the SSD.
- Thin **local** Time Machine snapshots (`tmutil thinlocalsnapshots` only). Does not add a TM destination.
- Copy-then-verify-then-remove leftover installers and one-shot archives from `~/Downloads` and `~/Desktop` into dated overflow on the current overflow volume:

  `$RICO_OVERFLOW_VOLUME/Rico-Overflow/YYYY-MM-DD/installers/`  
  `$RICO_OVERFLOW_VOLUME/Rico-Overflow/YYYY-MM-DD/archives/`

  Same-hash dest + leftover source is treated as already moved (idempotent). Different-hash dest is a hard refuse — never overwrite.

### Hard no (script skips or aborts)

- Format / erase / convert Movie Drive, or overwrite the ~2021 movie library
- SIP disable or reboot
- Time Machine onto the overflow volume (HFS + mixed movie library is a bad TM target; overflow/archive only)
- Relocating Littlebird, Hedy, LM Studio, llmster, apps, Messages, swap, or active working trees

### Needs Alan OK before anyone moves them

- `~/Documents` and other cold document trees Polar is not sure are daily-use
- Google Drive / `~/Library/CloudStorage`
- Movie files (`.mp4` / `.mov` / `.mkv` and the library already on Movie Drive)
- LM Studio / Qwen models, even suspected unused duplicates
- Xcode DerivedData, Docker, iOS backups, Photos, Mail
- Emptying Trash if it might contain Littlebird/Hedy
- Any Time Machine destination change

## Later: swap overflow to a USB4 / Thunderbolt SSD

Do not redesign this playbook. Edit **one file**:

`RicoDiskCleanup/overflow-target.zsh`

Change `RICO_OVERFLOW_VOLUME` and `RICO_OVERFLOW_VOLUME_NAME` to the new volume’s mount path and diskutil volume name. Set `RICO_OVERFLOW_DEVICE_CLASS` to `ssd-random`. Leave `RICO_OVERFLOW_ROOT_NAME` as `Rico-Overflow`.

The script keeps the same rules: sequential/cold leftovers only, copy-verify-remove, no Time Machine, no Littlebird/Hedy/LM Studio/llmster/app-support relocation. Movie Drive can stay plugged in as the movie library.

## How to tell it is done

On Rico, compare before/after in the written report (also printed at the end of the run):

```sh
df -h /System/Volumes/Data
df -h "/Volumes/Movie Drive"    # or the path in overflow-target.zsh after an SSD swap
```

Report path on Rico:

`~/Library/Logs/rico-disk-cleanup/report-<YYYYMMDDTHHMMSS>.txt`

On `--apply`, a copy is also written under `$OVERFLOW/Rico-Overflow/<date>/reports/` when the overflow volume is mounted.

Done means: host gate passed, SIP unchanged, Movie Drive still HFS “Movie Drive” with the old movie library intact, Littlebird/Hedy/llmster/LM Studio/apps/working trees still on the internal SSD, launch caches still present, and the report shows `df` before/after plus `moved=` / `cleared_cache_entries=` / `skipped_protected=` / `overflow_target=`.

## Facts Polar already confirmed (2026-08-25 ~6:17 a.m. ET)

- Internal APFS Data: ~460GB volume, ~400GB used, ~41GB free (~91%).
- External: `disk6`, 4.0 TB G-DRIVE (Thunderbolt USB 3.0), HFS volume name **Movie Drive**, mounted at `/Volumes/Movie Drive`, ~1.8TB used / ~1.8TB free. Media HGST HDS724040ALE640. Volume since ~2021 (movies).
- Polar’s host is original Rico only.

## Self-test (this repo / Polar before apply)

```sh
zsh RicoDiskCleanup/rico-disk-cleanup.zsh --self-test
```

Uses a temp fixture. It does not touch Rico’s real disks. It proves the Rico 2 / MacBook abort, Littlebird/Hedy/llmster/LM Studio/app/working-tree skip, launch-cache keep, leftover-installer-cache clear, copy-verify-remove, “do not overwrite movies”, and overflow path-swap (stand-in SSD) rules.
