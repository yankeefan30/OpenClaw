#!/bin/zsh
# Polar / local Cursor playbook runner for original Rico (Mac mini) only.
# Optimize for Rico performance: keep random-I/O and latency-sensitive data on
# the internal SSD. Overflow sequential/cold leftovers onto the volume named in
# overflow-target.zsh (today: 4TB G-DRIVE "Movie Drive"). Swapping that later
# to a USB4/Thunderbolt SSD is a path change, not a redesign.
#
# This script is the thing that touches Rico's disks. A GitHub-only cleanup is
# not a substitute. Cloud agents cannot see Rico's volumes.
#
# Never: format / erase / convert Movie Drive, overwrite movies, disable SIP,
# reboot, enable Time Machine on the overflow volume, move Littlebird / Hedy /
# LM Studio app support / llmster / apps / working trees, touch Messages/chat.db
# / Keychain / secrets, move Qwen models, operate Rico 2 or a MacBook, or send
# iMessage.
emulate -L zsh
set -euo pipefail
setopt nounset
setopt pipefail
setopt extendedglob
setopt typesetsilent

typeset -r SCRIPT_VERSION="1.1.0"
typeset -r SCRIPT_PATH="${0:A}"
typeset -r SCRIPT_DIR="${0:A:h}"
typeset -r REQUIRED_LOCAL_HOST_NAME="Rico"
typeset REQUIRED_VOLUME_NAME="Movie Drive"
typeset OVERFLOW_ROOT_NAME="Rico-Overflow"
typeset OVERFLOW_DEVICE_CLASS="hdd-sequential"
typeset PRODUCTION_OVERFLOW_VOLUME="/Volumes/Movie Drive"

typeset MODE="dry-run"
typeset FIXTURE_MODE=0
typeset FIXTURE_ROOT=""
typeset TEST_LOCAL_HOST_NAME=""
typeset TEST_HOST_FQDN=""
typeset TEST_USER_NAME=""
typeset APPLY=0
typeset AUDIT_ONLY=0

typeset HOME_DIR=""
typeset OVERFLOW_VOLUME=""
typeset TEST_OVERFLOW_VOLUME=""
typeset TEST_OVERFLOW_VOLUME_NAME=""
typeset OVERFLOW_DAY=""
typeset OVERFLOW_DIR=""
typeset REPORT_DIR=""
typeset REPORT_PATH=""
typeset LOCK_DIR=""
typeset -a REPORT_LINES=()
typeset -i MOVED_COUNT=0
typeset -i CLEARED_COUNT=0
typeset -i SKIPPED_PROTECTED=0
typeset -i ERROR_COUNT=0
typeset DF_BEFORE_DATA=""
typeset DF_BEFORE_MOVIE=""
typeset DF_AFTER_DATA=""
typeset DF_AFTER_MOVIE=""

usage() {
  cat <<'EOF'
Rico internal-disk cleanup for Polar (original Rico Mac mini only).

Usage:
  zsh RicoDiskCleanup/rico-disk-cleanup.zsh --dry-run
  zsh RicoDiskCleanup/rico-disk-cleanup.zsh --apply
  zsh RicoDiskCleanup/rico-disk-cleanup.zsh --audit-only
  zsh RicoDiskCleanup/rico-disk-cleanup.zsh --self-test

Default is --dry-run. --apply performs only the safe actions in the README.
Host-gates on scutil LocalHostName == Rico. Aborts on Rico 2 / MacBook.
Keeps latency-sensitive data on the internal SSD. Overflow path lives in
overflow-target.zsh (today Movie Drive; later a TB SSD is the same playbook).
Never formats Movie Drive. Never moves Littlebird, Hedy, llmster, or apps.
EOF
}

log() {
  local line="$1"
  print -r -- "$line"
  REPORT_LINES+="$line"
}

fail() {
  log "ERROR: $1"
  ERROR_COUNT=$((ERROR_COUNT + 1))
  print -u2 -r -- "ERROR: $1"
  exit 1
}

lower() {
  print -r -- "${1:l}"
}

is_truthy() {
  [[ "${1:-}" == 1 || "${1:-}" == true || "${1:-}" == yes ]]
}

load_overflow_target() {
  if [[ -f "${SCRIPT_DIR}/overflow-target.zsh" ]]; then
    source "${SCRIPT_DIR}/overflow-target.zsh"
  fi
  REQUIRED_VOLUME_NAME="${RICO_OVERFLOW_VOLUME_NAME:-Movie Drive}"
  OVERFLOW_ROOT_NAME="${RICO_OVERFLOW_ROOT_NAME:-Rico-Overflow}"
  OVERFLOW_DEVICE_CLASS="${RICO_OVERFLOW_DEVICE_CLASS:-hdd-sequential}"
  PRODUCTION_OVERFLOW_VOLUME="${RICO_OVERFLOW_VOLUME:-/Volumes/Movie Drive}"
}

# Fail closed: latency-sensitive and Alan-locked paths stay on the internal SSD.
path_is_protected() {
  local raw="$1"
  local p
  p="$(lower "$raw")"
  [[ -z "$p" ]] && return 1

  if [[ "$p" == *littlebird* || "$p" == *contextkit* || "$p" == *hedy* || "$p" == *llmster* ]]; then
    return 0
  fi
  if [[ "$p" == *lmstudio* || "$p" == *"lm studio"* || "$p" == *qwen* ]]; then
    return 0
  fi
  if [[ "$p" == /applications/* || "$p" == */applications/* || "$p" == *.app || "$p" == *.app/* ]]; then
    return 0
  fi
  if [[ "$p" == *openclawstudio* || "$p" == */.openclaw || "$p" == */.openclaw/* || "$p" == *openclaw* ]]; then
    return 0
  fi
  if [[ "$p" == */.cursor || "$p" == */.cursor/* || "$p" == *"/application support/cursor"* || "$p" == */library/caches/cursor* ]]; then
    return 0
  fi
  if [[ "$p" == */.codex || "$p" == */.codex/* || "$p" == *"/application support/codex"* || "$p" == */documents/codex* ]]; then
    return 0
  fi
  if [[ "$p" == */var/vm* || "$p" == *swapfile* || "$p" == *"/virtual machines"* ]]; then
    return 0
  fi

  case "$p" in
    */library/messages|*/library/messages/*|*/chat.db|*/chat.db-wal|*/chat.db-shm) return 0 ;;
    */library/keychains|*/library/keychains/*|*/.ssh|*/.ssh/*|*/.gnupg|*/.gnupg/*) return 0 ;;
    */library/application\ support/*) return 0 ;;
    */.lmstudio|*/.lmstudio/*|*qwen*.gguf|*lmstudio*models*) return 0 ;;
    */secrets|*/secrets/*|*.pem|*.p12|*.key|*.token|*credentials.json) return 0 ;;
  esac
  return 1
}

path_looks_like_model() {
  local p
  p="$(lower "$1")"
  [[ "$p" == *.gguf || "$p" == *.ggml || "$p" == *.safetensors || "$p" == *qwen* || "$p" == *lmstudio* || "$p" == *llmster* ]]
}

path_is_installer() {
  local p
  p="$(lower "$1")"
  [[ "$p" == *.dmg || "$p" == *.pkg || "$p" == *.iso ]]
}

path_is_oneshot_archive() {
  local p
  p="$(lower "$1")"
  [[ "$p" == *.zip || "$p" == *.tar || "$p" == *.tgz || "$p" == *.tar.gz || "$p" == *.7z || "$p" == *.rar ]]
}

# Regenerable leftover installer dumps only. App launch caches stay on the SSD.
is_leftover_installer_cache() {
  local raw="$1"
  local p base
  p="$(lower "$raw")"
  base="$(lower "${raw:t}")"
  [[ "$base" == homebrew || "$p" == */homebrew || "$p" == */homebrew/* ]] && return 0
  [[ "$p" == *.dmg || "$p" == *.pkg || "$p" == *.iso ]] && return 0
  return 1
}

path_is_movie() {
  local p
  p="$(lower "$1")"
  [[ "$p" == *.mp4 || "$p" == *.m4v || "$p" == *.mov || "$p" == *.mkv || "$p" == *.avi || "$p" == *.mpg || "$p" == *.mpeg ]]
}

must_be_under() {
  local child="${1:A}"
  local parent="${2:A}"
  [[ "$child" == "$parent" || "$child" == "$parent"/* ]]
}

file_sha256() {
  local file="$1" out
  if command -v shasum >/dev/null 2>&1; then
    out="$(shasum -a 256 -- "$file")"
  elif command -v sha256sum >/dev/null 2>&1; then
    out="$(sha256sum -- "$file")"
  else
    fail "no shasum/sha256sum on PATH"
  fi
  print -r -- "${${(s: :)out}[1]}"
}

copy_file() {
  local src="$1" dest="$2"
  if command -v ditto >/dev/null 2>&1; then
    ditto -- "$src" "$dest"
  else
    cp -p -- "$src" "$dest"
  fi
}

safe_diskutil() {
  local verb="${1:-}"
  shift || true
  case "$verb" in
    info|list)
      command diskutil "$verb" "$@"
      ;;
    *)
      fail "refusing diskutil ${verb:-<empty>} (erase/convert/partition are forbidden)"
      ;;
  esac
}

safe_tmutil() {
  local verb="${1:-}"
  shift || true
  case "$verb" in
    listlocalsnapshots|listlocalsnapshotdates|thinlocalsnapshots|destinationinfo)
      command tmutil "$verb" "$@"
      ;;
    *)
      fail "refusing tmutil ${verb:-<empty>} (Time Machine onto the overflow volume stays off)"
      ;;
  esac
}

identity_is_forbidden_host() {
  local value
  value="$(lower "${1:-}")"
  [[ -z "$value" ]] && return 1
  [[ "$value" == *macbook* ]] && return 0
  [[ "$value" == *rico2* || "$value" == *rico-2* || "$value" == *"rico 2"* ]] && return 0
  return 1
}

read_local_host_name() {
  if (( FIXTURE_MODE )); then
    print -r -- "$TEST_LOCAL_HOST_NAME"
    return
  fi
  command scutil --get LocalHostName
}

read_host_fqdn() {
  if (( FIXTURE_MODE )); then
    print -r -- "$TEST_HOST_FQDN"
    return
  fi
  command hostname
}

read_user_name() {
  if (( FIXTURE_MODE )); then
    print -r -- "${TEST_USER_NAME:-alan}"
    return
  fi
  id -un
}

require_original_rico() {
  local local_host_name host_fqdn host_short user_name computer_name=""
  local_host_name="$(read_local_host_name)"
  host_fqdn="$(read_host_fqdn)"
  host_short="${host_fqdn%%.*}"
  user_name="$(read_user_name)"

  if (( ! FIXTURE_MODE )); then
    computer_name="$(command scutil --get ComputerName 2>/dev/null || true)"
  fi

  log "Host gate: LocalHostName='${local_host_name}' hostname='${host_fqdn}' user='${user_name}' ComputerName='${computer_name}'"

  if identity_is_forbidden_host "$local_host_name" || identity_is_forbidden_host "$host_fqdn" || identity_is_forbidden_host "$host_short" || identity_is_forbidden_host "$computer_name"; then
    fail "refusing to run on Rico 2 / MacBook / non-original-Rico identity ('${local_host_name}' / '${host_fqdn}')"
  fi

  if [[ "$local_host_name" != "$REQUIRED_LOCAL_HOST_NAME" ]]; then
    fail "LocalHostName must be exactly ${REQUIRED_LOCAL_HOST_NAME} (got '${local_host_name}'). Polar's host is original Rico only."
  fi

  if [[ "$host_short" != "$REQUIRED_LOCAL_HOST_NAME" ]]; then
    fail "hostname must be Rico or Rico.local (got '${host_fqdn}')."
  fi

  if (( ! FIXTURE_MODE )) && [[ "$(id -u)" == 0 ]]; then
    fail "refusing to run as root"
  fi

  if [[ "$user_name" != "alan" ]]; then
    fail "refusing to run as '${user_name}'; expected alan on original Rico"
  fi
}

overflow_volume_name() {
  if (( FIXTURE_MODE )); then
    if [[ -d "$OVERFLOW_VOLUME" ]]; then
      print -r -- "$REQUIRED_VOLUME_NAME"
      return
    fi
    print -r -- ""
    return
  fi
  local info
  info="$(safe_diskutil info "$OVERFLOW_VOLUME" 2>/dev/null || true)"
  print -r -- "$info" | awk -F': *' '/Volume Name:/{print $2; exit}'
}

require_overflow_volume() {
  [[ -d "$OVERFLOW_VOLUME" ]] || fail "Overflow volume is not mounted at ${OVERFLOW_VOLUME}. Attach the current overflow disk (today: 4TB G-DRIVE). Do not format it."
  must_be_under "$OVERFLOW_VOLUME" "/Volumes" || {
    if (( ! FIXTURE_MODE )); then
      fail "Overflow volume path must be under /Volumes"
    fi
  }
  local volume_name
  volume_name="$(overflow_volume_name)"
  if [[ "$volume_name" != "$REQUIRED_VOLUME_NAME" ]]; then
    fail "refusing unexpected volume name '${volume_name}' (expected '${REQUIRED_VOLUME_NAME}'). Will not format or convert the disk."
  fi
  if [[ -w "$OVERFLOW_VOLUME" ]]; then
    :
  else
    fail "Overflow volume is not writable at ${OVERFLOW_VOLUME}"
  fi
  log "OVERFLOW ${OVERFLOW_VOLUME} name='${REQUIRED_VOLUME_NAME}' class=${OVERFLOW_DEVICE_CLASS} (edit overflow-target.zsh to point at a future USB4/TB SSD; Time Machine stays off)"
}

capture_df() {
  local target="$1"
  if [[ ! -e "$target" ]]; then
    print -r -- "MISSING ${target}"
    return
  fi
  df -h "$target" 2>/dev/null || df -h "$target"
}

du_size() {
  local target="$1" out
  out="$(du -sh "$target" 2>/dev/null || true)"
  out="${out%%$'\t'*}"
  print -r -- "${out%% *}"
}

append_audit_line() {
  local label="$1" target="$2"
  if [[ ! -e "$target" ]]; then
    log "AUDIT  ${label}: (absent)  ${target}"
    return
  fi
  if path_is_protected "$target"; then
    log "AUDIT  ${label}: $(du_size "$target")  ${target}  [PROTECTED — leave on internal disk]"
    return
  fi
  log "AUDIT  ${label}: $(du_size "$target")  ${target}"
}

audit_usual_hogs() {
  log "---- audit: usual hogs ----"
  append_audit_line "internal Data" "/System/Volumes/Data"
  append_audit_line "overflow volume" "$OVERFLOW_VOLUME"
  append_audit_line "home" "$HOME_DIR"
  append_audit_line "Caches (launch caches stay)" "$HOME_DIR/Library/Caches"
  append_audit_line "Logs" "$HOME_DIR/Library/Logs"
  append_audit_line "Downloads" "$HOME_DIR/Downloads"
  append_audit_line "Desktop" "$HOME_DIR/Desktop"
  append_audit_line "Documents (cold only + Alan OK)" "$HOME_DIR/Documents"
  append_audit_line "Movies (cold only + Alan OK)" "$HOME_DIR/Movies"
  append_audit_line "Google Drive (Alan OK)" "$HOME_DIR/Library/CloudStorage"
  append_audit_line "LM Studio home (SSD)" "$HOME_DIR/.lmstudio"
  append_audit_line "LM Studio app support (SSD)" "$HOME_DIR/Library/Application Support/LM Studio"
  append_audit_line "llmster (SSD)" "$HOME_DIR/Library/Application Support/llmster"
  append_audit_line "OpenClawStudio (SSD)" "$HOME_DIR/OpenClawStudio"
  append_audit_line "Cursor support (SSD)" "$HOME_DIR/Library/Application Support/Cursor"
  append_audit_line "Messages (do not touch)" "$HOME_DIR/Library/Messages"
  append_audit_line "Keychains (do not touch)" "$HOME_DIR/Library/Keychains"
  append_audit_line "Littlebird app (SSD)" "/Applications/Littlebird.app"
  append_audit_line "Littlebird support (SSD)" "$HOME_DIR/Library/Application Support/Littlebird"
  append_audit_line "ContextKit (SSD)" "$HOME_DIR/Library/Application Support/ContextKit"
  append_audit_line "Hedy app (SSD)" "/Applications/Hedy.app"
  append_audit_line "Hedy support (SSD)" "$HOME_DIR/Library/Application Support/Hedy"

  if [[ -d "$HOME_DIR/Library/Caches" ]]; then
    log "AUDIT  top cache dirs:"
    local cache_line
    while IFS= read -r cache_line; do
      log "AUDIT    $cache_line"
    done < <(du -sh "$HOME_DIR/Library/Caches"/*(N) 2>/dev/null | sort -hr | head -n 25 || true)
  fi

  if [[ -d "$HOME_DIR/Downloads" ]]; then
    log "AUDIT  Downloads installers / bulky leftovers:"
    local item size
    for item in "$HOME_DIR/Downloads"/*.(#i)(dmg|pkg|iso)(N.); do
      size="$(du_size "$item")"
      if path_is_protected "$item"; then
        log "AUDIT    ${size:-?}  ${item}  [PROTECTED skip — stay on SSD]"
      else
        log "AUDIT    ${size:-?}  ${item}  [HDD overflow OK]"
      fi
    done
    for item in "$HOME_DIR/Downloads"/*.(#i)(zip|tar|tgz|7z|rar)(N.) "$HOME_DIR/Downloads"/*.tar.gz(N.); do
      size="$(du_size "$item")"
      if path_is_protected "$item" || path_looks_like_model "$item"; then
        log "AUDIT    ${size:-?}  ${item}  [PROTECTED skip — stay on SSD]"
      else
        log "AUDIT    ${size:-?}  ${item}  [one-shot archive; HDD overflow OK]"
      fi
    done
  fi
}

skip_protected() {
  local target="$1" reason="$2"
  SKIPPED_PROTECTED=$((SKIPPED_PROTECTED + 1))
  log "SKIP   ${target}  (${reason})"
}

clear_leftover_installer_caches() {
  local root="$1"
  [[ -d "$root" ]] || return 0
  must_be_under "$root" "$HOME_DIR/Library/Caches" || fail "refusing to clear cache outside ~/Library/Caches: $root"

  log "---- leftover installer caches only (launch caches stay on SSD) ----"
  local child
  for child in "$root"/*(N); do
    if path_is_protected "$child"; then
      skip_protected "$child" "protected / latency-sensitive cache stays on SSD"
      continue
    fi
    if ! is_leftover_installer_cache "$child"; then
      log "KEEP   ${child}  (active/unknown cache — snappy launch, stay on SSD)"
      continue
    fi
    if (( ! APPLY )); then
      log "WOULD  clear leftover installer cache  ${child}"
      continue
    fi
    rm -rf -- "$child"
    CLEARED_COUNT=$((CLEARED_COUNT + 1))
    log "CLEAR  ${child}"
  done
}

thin_local_tm_snapshots() {
  if (( FIXTURE_MODE )); then
    log "SKIP   local Time Machine snapshots (fixture mode)"
    return
  fi
  if ! command -v tmutil >/dev/null 2>&1; then
    log "SKIP   tmutil not present"
    return
  fi
  log "---- local Time Machine snapshots ----"
  local listed
  listed="$(safe_tmutil listlocalsnapshots / 2>/dev/null || true)"
  if [[ -z "$listed" ]]; then
    log "AUDIT  no local TM snapshots"
    return
  fi
  log "AUDIT  local snapshots before:"
  print -r -- "$listed" | while IFS= read -r line; do
    log "AUDIT    $line"
  done
  if (( ! APPLY )); then
    log "WOULD  tmutil thinlocalsnapshots / 10000000000 4"
    return
  fi
  # Purge local snapshots only. Does not add Movie Drive as a TM destination.
  safe_tmutil thinlocalsnapshots / 10000000000 4 || log "WARN   thinlocalsnapshots returned non-zero (often OK if nothing eligible)"
  listed="$(safe_tmutil listlocalsnapshots / 2>/dev/null || true)"
  log "AUDIT  local snapshots after:"
  print -r -- "${listed:-none}" | while IFS= read -r line; do
    log "AUDIT    $line"
  done
}

ensure_overflow_dir() {
  OVERFLOW_DAY="$(TZ=America/New_York date +%F)"
  OVERFLOW_DIR="${OVERFLOW_VOLUME}/${OVERFLOW_ROOT_NAME}/${OVERFLOW_DAY}"
  if (( APPLY )); then
    require_overflow_volume
    mkdir -p -- "$OVERFLOW_DIR/installers" "$OVERFLOW_DIR/archives" "$OVERFLOW_DIR/reports"
    [[ -d "$OVERFLOW_DIR/installers" ]] || fail "failed to create overflow ${OVERFLOW_DIR}"
  else
    if [[ -d "$OVERFLOW_VOLUME" ]]; then
      log "WOULD  mkdir ${OVERFLOW_DIR}/installers"
    else
      log "WARN   overflow volume not mounted at ${OVERFLOW_VOLUME}; installer moves will be skipped"
    fi
  fi
}

move_installer() {
  local src="$1"
  if [[ ! -f "$src" ]]; then
    return 0
  fi
  if [[ -L "$src" ]]; then
    skip_protected "$src" "symlink — will not follow"
    return 0
  fi
  if path_is_protected "$src"; then
    skip_protected "$src" "Littlebird/Hedy/protected name"
    return 0
  fi
  if path_looks_like_model "$src"; then
    skip_protected "$src" "model-like file stays on internal disk unless Alan OK"
    return 0
  fi
  if path_is_movie "$src"; then
    skip_protected "$src" "movie file — Alan OK required; never overwrite the existing movie library"
    return 0
  fi
  if ! path_is_installer "$src"; then
    return 0
  fi

  move_installer_to "$src" "${OVERFLOW_DIR}/installers/${src:t}"
}

move_oneshot_archive() {
  local src="$1"
  if [[ ! -f "$src" || -L "$src" ]]; then
    return 0
  fi
  if path_is_protected "$src" || path_looks_like_model "$src" || path_is_movie "$src"; then
    skip_protected "$src" "protected / latency-sensitive / media — stay on SSD unless Alan OK"
    return 0
  fi
  if ! path_is_oneshot_archive "$src"; then
    return 0
  fi
  move_installer_to "$src" "${OVERFLOW_DIR}/archives/${src:t}"
}

move_installer_to() {
  local src="$1" dest="$2"
  if [[ -e "$dest" ]]; then
    if [[ "$(file_sha256 "$src")" == "$(file_sha256 "$dest")" ]]; then
      if (( APPLY )); then
        rm -f -- "$src"
        MOVED_COUNT=$((MOVED_COUNT + 1))
        log "IDEMP  already on overflow volume, removed internal copy  ${src}"
      else
        log "WOULD  remove already-copied leftover  ${src}"
      fi
      return 0
    fi
    fail "refusing to overwrite existing overflow file with different contents: $dest"
  fi
  if (( ! APPLY )); then
    log "WOULD  copy-verify-remove  ${src}  ->  ${dest}"
    return 0
  fi
  require_overflow_volume
  must_be_under "$dest" "${OVERFLOW_VOLUME}/${OVERFLOW_ROOT_NAME}" || fail "overflow dest escaped Rico-Overflow: $dest"
  mkdir -p -- "${dest:h}"
  local tmp="${dest}.partial.${RANDOM}"
  copy_file "$src" "$tmp"
  local src_hash dest_hash
  src_hash="$(file_sha256 "$src")"
  dest_hash="$(file_sha256 "$tmp")"
  if [[ "$src_hash" != "$dest_hash" ]]; then
    rm -f -- "$tmp"
    fail "checksum mismatch after copy, source kept: $src"
  fi
  mv -n -- "$tmp" "$dest"
  if [[ ! -f "$dest" ]] || [[ "$(file_sha256 "$dest")" != "$src_hash" ]]; then
    fail "verified place failed, source kept: $src"
  fi
  rm -f -- "$src"
  if [[ -e "$src" ]]; then
    fail "source still present after verified copy: $src"
  fi
  MOVED_COUNT=$((MOVED_COUNT + 1))
  log "MOVE   ${src}  ->  ${dest}  sha256=${src_hash}"
}

move_safe_installers() {
  log "---- overflow sequential leftovers (copy-verify-remove) ----"
  local search_root item
  for search_root in "$HOME_DIR/Downloads" "$HOME_DIR/Desktop"; do
    [[ -d "$search_root" ]] || continue
    for item in "$search_root"/*.(#i)(dmg|pkg|iso)(N.); do
      move_installer "$item"
    done
    for item in "$search_root"/*.(#i)(zip|tar|tgz|7z|rar)(N.) "$search_root"/*.tar.gz(N.); do
      move_oneshot_archive "$item"
    done
  done
}

write_report() {
  REPORT_DIR="${HOME_DIR}/Library/Logs/rico-disk-cleanup"
  local stamp
  stamp="$(TZ=America/New_York date +%Y%m%dT%H%M%S)"
  mkdir -p -- "$REPORT_DIR"
  REPORT_PATH="${REPORT_DIR}/report-${stamp}.txt"
  {
    print -r -- "Rico disk cleanup report"
    print -r -- "script=${SCRIPT_PATH}"
    print -r -- "version=${SCRIPT_VERSION}"
    print -r -- "mode=${MODE}"
    print -r -- "when=$(TZ=America/New_York date '+%Y-%m-%d %H:%M:%S %Z')"
    print -r -- "report=${REPORT_PATH}"
    print -r -- ""
    print -r -- "==== df /System/Volumes/Data BEFORE ===="
    print -r -- "$DF_BEFORE_DATA"
    print -r -- "==== df overflow volume BEFORE (${OVERFLOW_VOLUME}) ===="
    print -r -- "$DF_BEFORE_MOVIE"
    print -r -- ""
    print -l -- "${REPORT_LINES[@]}"
    print -r -- ""
    print -r -- "==== df /System/Volumes/Data AFTER ===="
    print -r -- "$DF_AFTER_DATA"
    print -r -- "==== df overflow volume AFTER (${OVERFLOW_VOLUME}) ===="
    print -r -- "$DF_AFTER_MOVIE"
    print -r -- ""
    print -r -- "moved=${MOVED_COUNT} cleared_cache_entries=${CLEARED_COUNT} skipped_protected=${SKIPPED_PROTECTED} errors=${ERROR_COUNT}"
    print -r -- "overflow_target=${OVERFLOW_VOLUME} class=${OVERFLOW_DEVICE_CLASS} (edit overflow-target.zsh to swap to a USB4/TB SSD)"
    print -r -- "SIP was not changed. Host was not rebooted. Overflow volume was not formatted. Time Machine destination was not added."
    print -r -- "Littlebird, Hedy, llmster, LM Studio/Qwen, apps, Messages, and working trees stayed on the internal SSD."
  } >"$REPORT_PATH"
  chmod 600 "$REPORT_PATH" 2>/dev/null || true
  if (( APPLY )) && [[ -d "${OVERFLOW_DIR}/reports" ]]; then
    cp -p -- "$REPORT_PATH" "${OVERFLOW_DIR}/reports/${REPORT_PATH:t}"
  fi
  log "REPORT ${REPORT_PATH}"
}

release_lock() {
  if [[ -n "$LOCK_DIR" && -d "$LOCK_DIR" ]]; then
    rm -rf -- "$LOCK_DIR"
  fi
}

acquire_lock() {
  LOCK_DIR="${HOME_DIR}/Library/Logs/rico-disk-cleanup/lock"
  mkdir -p -- "${LOCK_DIR:h}"
  if ! mkdir -- "$LOCK_DIR" 2>/dev/null; then
    fail "another rico-disk-cleanup run holds ${LOCK_DIR}"
  fi
  print -r -- "$$" >"${LOCK_DIR}/pid"
  trap release_lock EXIT
}

run_cleanup() {
  load_overflow_target
  HOME_DIR="${HOME}"
  OVERFLOW_VOLUME="$PRODUCTION_OVERFLOW_VOLUME"
  if (( FIXTURE_MODE )); then
    HOME_DIR="${FIXTURE_ROOT}/Users/alan"
    if [[ -n "$TEST_OVERFLOW_VOLUME" ]]; then
      OVERFLOW_VOLUME="$TEST_OVERFLOW_VOLUME"
      REQUIRED_VOLUME_NAME="${TEST_OVERFLOW_VOLUME_NAME:-$REQUIRED_VOLUME_NAME}"
    else
      OVERFLOW_VOLUME="${FIXTURE_ROOT}/Volumes/Movie Drive"
    fi
    export HOME="$HOME_DIR"
  fi

  acquire_lock
  require_original_rico
  log "POLICY keep latency-sensitive data on internal SSD; overflow sequential leftovers only"
  log "POLICY overflow-target ${OVERFLOW_VOLUME} class=${OVERFLOW_DEVICE_CLASS}"

  if (( ! FIXTURE_MODE )); then
    if command -v csrutil >/dev/null 2>&1; then
      log "SIP    $(csrutil status 2>/dev/null | tr '\n' ' ')"
    fi
    if command -v tmutil >/dev/null 2>&1; then
      log "TM     destinationinfo (overflow volume must NOT be a Time Machine disk):"
      safe_tmutil destinationinfo 2>/dev/null | while IFS= read -r line; do
        log "TM       $line"
      done
    fi
  fi

  DF_BEFORE_DATA="$(capture_df /System/Volumes/Data)"
  DF_BEFORE_MOVIE="$(capture_df "$OVERFLOW_VOLUME")"
  log "---- df BEFORE ----"
  log "$DF_BEFORE_DATA"
  log "$DF_BEFORE_MOVIE"

  audit_usual_hogs
  if (( AUDIT_ONLY )); then
    DF_AFTER_DATA="$(capture_df /System/Volumes/Data)"
    DF_AFTER_MOVIE="$(capture_df "$OVERFLOW_VOLUME")"
    write_report
    return
  fi

  ensure_overflow_dir
  clear_leftover_installer_caches "$HOME_DIR/Library/Caches"
  thin_local_tm_snapshots
  if [[ -d "$OVERFLOW_VOLUME" ]]; then
    move_safe_installers
  else
    log "SKIP   installer overflow (volume not mounted at ${OVERFLOW_VOLUME})"
  fi

  DF_AFTER_DATA="$(capture_df /System/Volumes/Data)"
  DF_AFTER_MOVIE="$(capture_df "$OVERFLOW_VOLUME")"
  log "---- df AFTER ----"
  log "$DF_AFTER_DATA"
  log "$DF_AFTER_MOVIE"
  write_report

  log "DONE   mode=${MODE} moved=${MOVED_COUNT} cleared=${CLEARED_COUNT} skipped_protected=${SKIPPED_PROTECTED}"
  log "DONE   report=${REPORT_PATH}"
  log "DONE   confirm with: df -h /System/Volumes/Data && df -h \"${OVERFLOW_VOLUME}\""
  release_lock
}

assert_self_test() {
  local label="$1"
  local cond="$2"
  if eval "$cond"; then
    print -r -- "PASS  ${label}"
  else
    print -u2 -r -- "FAIL  ${label}  (${cond})"
    exit 1
  fi
}

run_self_test() {
  local tmp
  tmp="$(mktemp -d /tmp/rico-disk-cleanup-selftest.XXXXXX)"
  print -r -- "self-test fixture ${tmp}"

  # Host-gate unit checks (no disk side effects).
  identity_is_forbidden_host "Rico2" || { print -u2 "FAIL forbidden Rico2"; exit 1; }
  identity_is_forbidden_host "Rico-2" || { print -u2 "FAIL forbidden Rico-2"; exit 1; }
  identity_is_forbidden_host "Rico 2" || { print -u2 "FAIL forbidden Rico 2"; exit 1; }
  identity_is_forbidden_host "Alans-MacBook-Pro" || { print -u2 "FAIL forbidden MacBook"; exit 1; }
  identity_is_forbidden_host "Rico" && { print -u2 "FAIL Rico should be allowed"; exit 1; }
  path_is_protected "/Applications/Littlebird.app" || { print -u2 "FAIL Littlebird.app"; exit 1; }
  path_is_protected "/Users/alan/Library/Application Support/Littlebird/db" || { print -u2 "FAIL Littlebird support"; exit 1; }
  path_is_protected "/Users/alan/Library/Application Support/ContextKit" || { print -u2 "FAIL ContextKit"; exit 1; }
  path_is_protected "/Applications/Hedy.app" || { print -u2 "FAIL Hedy.app"; exit 1; }
  path_is_protected "/Users/alan/Library/Application Support/Hedy/models/x" || { print -u2 "FAIL Hedy support"; exit 1; }
  path_is_protected "/Users/alan/Library/LaunchAgents/com.hedy.helper.plist" || { print -u2 "FAIL Hedy launch agent"; exit 1; }
  path_is_protected "/Users/alan/.openclaw/hedy/config.json" || { print -u2 "FAIL OpenClaw/Hedy"; exit 1; }
  path_is_protected "/Users/alan/Library/Messages/chat.db" || { print -u2 "FAIL chat.db"; exit 1; }
  path_is_protected "/Users/alan/Downloads/Hedy-Installer.dmg" || { print -u2 "FAIL Hedy installer name"; exit 1; }
  path_is_protected "/Users/alan/Downloads/Littlebird.pkg" || { print -u2 "FAIL Littlebird installer name"; exit 1; }
  path_is_protected "/Users/alan/Library/Application Support/LM Studio/models/qwen.gguf" || { print -u2 "FAIL LM Studio support"; exit 1; }
  path_is_protected "/Users/alan/Library/Application Support/llmster/store" || { print -u2 "FAIL llmster"; exit 1; }
  path_is_protected "/Users/alan/OpenClawStudio/RicoIMessageMCP" || { print -u2 "FAIL OpenClawStudio tree"; exit 1; }
  path_is_protected "/Users/alan/Library/Application Support/Cursor/Cache" || { print -u2 "FAIL Cursor support"; exit 1; }
  path_is_protected "/Applications/Safari.app" || { print -u2 "FAIL /Applications stay"; exit 1; }
  path_is_protected "/private/var/vm/swapfile0" || { print -u2 "FAIL swap"; exit 1; }
  path_is_protected "/Users/alan/Downloads/Chrome.dmg" && { print -u2 "FAIL Chrome.dmg should not be protected"; exit 1; }
  path_is_protected "/Users/alan/Downloads/old-archive.zip" && { print -u2 "FAIL zip should be overflow-eligible"; exit 1; }
  is_leftover_installer_cache "/Users/alan/Library/Caches/Homebrew" || { print -u2 "FAIL Homebrew leftover cache"; exit 1; }
  is_leftover_installer_cache "/Users/alan/Library/Caches/com.apple.Safari" && { print -u2 "FAIL Safari is not leftover installer cache"; exit 1; }
  print -r -- "PASS  host-gate and skip-rule predicates"

  mkdir -p -- \
    "${tmp}/Users/alan/Library/Caches/com.apple.Safari" \
    "${tmp}/Users/alan/Library/Caches/Homebrew" \
    "${tmp}/Users/alan/Library/Caches/Cursor" \
    "${tmp}/Users/alan/Library/Caches/Littlebird" \
    "${tmp}/Users/alan/Library/Caches/Hedy" \
    "${tmp}/Users/alan/Library/Caches/ContextKit" \
    "${tmp}/Users/alan/Library/Application Support/Littlebird" \
    "${tmp}/Users/alan/Library/Application Support/Hedy/models" \
    "${tmp}/Users/alan/Library/Application Support/ContextKit" \
    "${tmp}/Users/alan/Library/Application Support/LM Studio/models" \
    "${tmp}/Users/alan/Library/Application Support/llmster" \
    "${tmp}/Users/alan/Library/Application Support/Cursor" \
    "${tmp}/Users/alan/Library/Messages" \
    "${tmp}/Users/alan/Library/Keychains" \
    "${tmp}/Users/alan/Library/Logs/rico-disk-cleanup" \
    "${tmp}/Users/alan/Downloads" \
    "${tmp}/Users/alan/Desktop" \
    "${tmp}/Users/alan/.lmstudio/models" \
    "${tmp}/Users/alan/OpenClawStudio/RicoIMessageMCP" \
    "${tmp}/Volumes/Movie Drive/Movies From 2021" \
    "${tmp}/Volumes/Rico-Overflow-SSD" \
    "${tmp}/Applications/Littlebird.app/Contents"

  print -r -- "safari-cache" >"${tmp}/Users/alan/Library/Caches/com.apple.Safari/cache.db"
  print -r -- "brew-bottle" >"${tmp}/Users/alan/Library/Caches/Homebrew/foo.bottle"
  print -r -- "cursor-cache" >"${tmp}/Users/alan/Library/Caches/Cursor/gpu-cache"
  print -r -- "littlebird-cache" >"${tmp}/Users/alan/Library/Caches/Littlebird/keep.me"
  print -r -- "hedy-cache" >"${tmp}/Users/alan/Library/Caches/Hedy/keep.me"
  print -r -- "contextkit-cache" >"${tmp}/Users/alan/Library/Caches/ContextKit/keep.me"
  print -r -- "littlebird-data" >"${tmp}/Users/alan/Library/Application Support/Littlebird/state.db"
  print -r -- "hedy-model" >"${tmp}/Users/alan/Library/Application Support/Hedy/models/weights.bin"
  print -r -- "context-data" >"${tmp}/Users/alan/Library/Application Support/ContextKit/index"
  print -r -- "qwen-model" >"${tmp}/Users/alan/.lmstudio/models/qwen3.gguf"
  print -r -- "llmster-state" >"${tmp}/Users/alan/Library/Application Support/llmster/store"
  print -r -- "cursor-ws" >"${tmp}/Users/alan/Library/Application Support/Cursor/workspace.json"
  print -r -- "openclaw-tree" >"${tmp}/Users/alan/OpenClawStudio/RicoIMessageMCP/index.mjs"
  print -r -- "chat-secret" >"${tmp}/Users/alan/Library/Messages/chat.db"
  print -r -- "keychain-secret" >"${tmp}/Users/alan/Library/Keychains/login.keychain-db"
  print -r -- "installer-body" >"${tmp}/Users/alan/Downloads/Xcode-old.dmg"
  print -r -- "oneshot-zip" >"${tmp}/Users/alan/Downloads/old-archive.zip"
  print -r -- "hedy-installer" >"${tmp}/Users/alan/Downloads/Hedy-Installer.dmg"
  print -r -- "littlebird-pkg" >"${tmp}/Users/alan/Downloads/Littlebird.pkg"
  print -r -- "a-movie" >"${tmp}/Users/alan/Downloads/Family-Video.mp4"
  print -r -- "keep-this-movie" >"${tmp}/Volumes/Movie Drive/Movies From 2021/keep.mov"
  print -r -- "littlebird-bin" >"${tmp}/Applications/Littlebird.app/Contents/MacOS-placeholder"

  FIXTURE_MODE=1
  FIXTURE_ROOT="$tmp"
  TEST_LOCAL_HOST_NAME="Rico2"
  TEST_HOST_FQDN="Rico2.local"
  TEST_USER_NAME="alan"
  MODE="apply"
  APPLY=1
  if ( run_cleanup ) >/tmp/rico-disk-cleanup-rico2.log 2>&1; then
    print -u2 "FAIL  host gate allowed Rico2"
    exit 1
  fi
  print -r -- "PASS  abort on LocalHostName=Rico2"

  TEST_LOCAL_HOST_NAME="Rico"
  TEST_HOST_FQDN="Alans-MacBook-Pro.local"
  if ( run_cleanup ) >/tmp/rico-disk-cleanup-macbook.log 2>&1; then
    print -u2 "FAIL  host gate allowed MacBook hostname"
    exit 1
  fi
  print -r -- "PASS  abort on MacBook hostname"

  TEST_LOCAL_HOST_NAME="Rico"
  TEST_HOST_FQDN="Rico.local"
  TEST_USER_NAME="alan"
  MODE="apply"
  APPLY=1
  AUDIT_ONLY=0
  MOVED_COUNT=0
  CLEARED_COUNT=0
  SKIPPED_PROTECTED=0
  ERROR_COUNT=0
  REPORT_LINES=()
  run_cleanup

  local overflow_dmg overflow_zip overflow_hedy overflow_littlebird
  overflow_dmg="$(print -r -- "${tmp}/Volumes/Movie Drive/${OVERFLOW_ROOT_NAME}"/*/installers/Xcode-old.dmg(N[1]))"
  overflow_zip="$(print -r -- "${tmp}/Volumes/Movie Drive/${OVERFLOW_ROOT_NAME}"/*/archives/old-archive.zip(N[1]))"
  overflow_hedy="$(print -r -- "${tmp}/Volumes/Movie Drive/${OVERFLOW_ROOT_NAME}"/*/installers/Hedy-Installer.dmg(N[1]))"
  overflow_littlebird="$(print -r -- "${tmp}/Volumes/Movie Drive/${OVERFLOW_ROOT_NAME}"/*/installers/Littlebird.pkg(N[1]))"

  assert_self_test "Safari launch cache stays on SSD" "[[ -e '${tmp}/Users/alan/Library/Caches/com.apple.Safari/cache.db' ]]"
  assert_self_test "Cursor cache stays on SSD" "[[ -e '${tmp}/Users/alan/Library/Caches/Cursor/gpu-cache' ]]"
  assert_self_test "Homebrew leftover cache cleared" "[[ ! -e '${tmp}/Users/alan/Library/Caches/Homebrew/foo.bottle' ]]"
  assert_self_test "Littlebird cache stays" "[[ -e '${tmp}/Users/alan/Library/Caches/Littlebird/keep.me' ]]"
  assert_self_test "Hedy cache stays" "[[ -e '${tmp}/Users/alan/Library/Caches/Hedy/keep.me' ]]"
  assert_self_test "ContextKit cache stays" "[[ -e '${tmp}/Users/alan/Library/Caches/ContextKit/keep.me' ]]"
  assert_self_test "Littlebird support stays" "[[ -e '${tmp}/Users/alan/Library/Application Support/Littlebird/state.db' ]]"
  assert_self_test "Hedy model stays" "[[ -e '${tmp}/Users/alan/Library/Application Support/Hedy/models/weights.bin' ]]"
  assert_self_test "LM Studio model stays" "[[ -e '${tmp}/Users/alan/.lmstudio/models/qwen3.gguf' ]]"
  assert_self_test "llmster stays" "[[ -e '${tmp}/Users/alan/Library/Application Support/llmster/store' ]]"
  assert_self_test "Cursor support stays" "[[ -e '${tmp}/Users/alan/Library/Application Support/Cursor/workspace.json' ]]"
  assert_self_test "OpenClawStudio tree stays" "[[ -e '${tmp}/Users/alan/OpenClawStudio/RicoIMessageMCP/index.mjs' ]]"
  assert_self_test "chat.db stays" "[[ -e '${tmp}/Users/alan/Library/Messages/chat.db' ]]"
  assert_self_test "keychain stays" "[[ -e '${tmp}/Users/alan/Library/Keychains/login.keychain-db' ]]"
  assert_self_test "existing movie untouched" "[[ -e '${tmp}/Volumes/Movie Drive/Movies From 2021/keep.mov' ]]"
  assert_self_test "safe dmg overflowed" "[[ -f '$overflow_dmg' ]]"
  assert_self_test "one-shot zip overflowed" "[[ -f '$overflow_zip' ]]"
  assert_self_test "safe dmg removed from Downloads" "[[ ! -e '${tmp}/Users/alan/Downloads/Xcode-old.dmg' ]]"
  assert_self_test "Hedy installer not overflowed" "[[ -e '${tmp}/Users/alan/Downloads/Hedy-Installer.dmg' && -z '$overflow_hedy' ]]"
  assert_self_test "Littlebird pkg not overflowed" "[[ -e '${tmp}/Users/alan/Downloads/Littlebird.pkg' && -z '$overflow_littlebird' ]]"
  assert_self_test "mp4 not overflowed" "[[ -e '${tmp}/Users/alan/Downloads/Family-Video.mp4' ]]"
  assert_self_test "report written" "[[ -n '${REPORT_PATH}' && -f '${REPORT_PATH}' ]]"
  assert_self_test "Littlebird.app stays" "[[ -e '${tmp}/Applications/Littlebird.app/Contents/MacOS-placeholder' ]]"

  # Idempotent second apply.
  MOVED_COUNT=0
  CLEARED_COUNT=0
  SKIPPED_PROTECTED=0
  REPORT_LINES=()
  run_cleanup
  overflow_dmg="$(print -r -- "${tmp}/Volumes/Movie Drive/${OVERFLOW_ROOT_NAME}"/*/installers/Xcode-old.dmg(N[1]))"
  assert_self_test "idempotent: movie still present" "[[ -e '${tmp}/Volumes/Movie Drive/Movies From 2021/keep.mov' ]]"
  assert_self_test "idempotent: Hedy still present" "[[ -e '${tmp}/Users/alan/Library/Application Support/Hedy/models/weights.bin' ]]"
  assert_self_test "idempotent: overflow dmg still one copy" "[[ -f '$overflow_dmg' ]]"

  # Path change only: point overflow at a stand-in USB4/TB SSD volume.
  print -r -- "ssd-installer" >"${tmp}/Users/alan/Desktop/OldTools.dmg"
  TEST_OVERFLOW_VOLUME="${tmp}/Volumes/Rico-Overflow-SSD"
  TEST_OVERFLOW_VOLUME_NAME="Rico-Overflow-SSD"
  OVERFLOW_DEVICE_CLASS="ssd-random"
  MOVED_COUNT=0
  CLEARED_COUNT=0
  SKIPPED_PROTECTED=0
  REPORT_LINES=()
  run_cleanup
  local ssd_dmg
  ssd_dmg="$(print -r -- "${tmp}/Volumes/Rico-Overflow-SSD/${OVERFLOW_ROOT_NAME}"/*/installers/OldTools.dmg(N[1]))"
  assert_self_test "SSD path swap overflowed installer" "[[ -f '$ssd_dmg' ]]"
  assert_self_test "SSD path swap did not rewrite Movie Drive library" "[[ -e '${tmp}/Volumes/Movie Drive/Movies From 2021/keep.mov' ]]"
  assert_self_test "SSD path swap left llmster on SSD home" "[[ -e '${tmp}/Users/alan/Library/Application Support/llmster/store' ]]"

  rm -rf -- "$tmp"
  print -r -- "PASS  all rico-disk-cleanup self-tests"
}

parse_args() {
  if [[ $# -eq 0 ]]; then
    MODE="dry-run"
    APPLY=0
    return
  fi
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run) MODE="dry-run"; APPLY=0 ;;
      --apply) MODE="apply"; APPLY=1 ;;
      --audit-only) MODE="audit-only"; AUDIT_ONLY=1; APPLY=0 ;;
      --self-test) MODE="self-test" ;;
      -h|--help) usage; exit 0 ;;
      *) usage; fail "unknown argument: $1" ;;
    esac
    shift
  done
}

main() {
  parse_args "$@"
  if [[ "$MODE" == "self-test" ]]; then
    run_self_test
    return
  fi
  run_cleanup
}

main "$@"
