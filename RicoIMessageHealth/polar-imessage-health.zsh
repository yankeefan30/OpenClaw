#!/usr/bin/env zsh
# polar-imessage-health.zsh
#
# Daily Messages.app Apple Event healthcheck for original Rico only.
# Read-only AE probe. No iMessage is sent. No OpenClaw / gateway restart.
# No SIP / TCC changes. No Rico 2.
#
# Polar diagnosed 2026-08-19: a long-lived Messages.app (PID 9037, up since
# 2026-08-16 17:04 ET) never completed the send Apple Event. imsg 0.14.1
# AppleScriptSendTransport → osascript hit the 120s AE wait-for-reply bound.
# This job runs at 06:00 America/New_York so COS 06:30 has a live AE path.

emulate -L zsh
setopt no_unset pipefail
zmodload zsh/datetime 2>/dev/null || true

typeset -g HEALTH_BIN_HOSTNAME="${HEALTH_BIN_HOSTNAME:-/bin/hostname}"
typeset -g HEALTH_BIN_SCUTIL="${HEALTH_BIN_SCUTIL:-/usr/sbin/scutil}"
typeset -g HEALTH_BIN_OSASCRIPT="${HEALTH_BIN_OSASCRIPT:-/usr/bin/osascript}"
typeset -g HEALTH_BIN_PS="${HEALTH_BIN_PS:-/bin/ps}"
typeset -g HEALTH_BIN_OPEN="${HEALTH_BIN_OPEN:-/usr/bin/open}"
typeset -g HEALTH_BIN_IMSG="${HEALTH_BIN_IMSG:-/opt/homebrew/bin/imsg}"

typeset -g LOG_PATH="${POLAR_IHEALTH_LOG:-/Users/alan/Library/Logs/polar-imessage-health.log}"
typeset -g STATE_PATH="${POLAR_IHEALTH_STATE:-/Users/alan/Library/Logs/polar-imessage-health.state.json}"
typeset -g AE_TIMEOUT="${POLAR_IHEALTH_AE_TIMEOUT:-12}"
typeset -g QUIT_TIMEOUT="${POLAR_IHEALTH_QUIT_TIMEOUT:-8}"
typeset -g START_WAIT="${POLAR_IHEALTH_START_WAIT:-20}"
typeset -g HUNG_SEC="${POLAR_IHEALTH_HUNG_SEC:-25}"
typeset -g LONG_LIVED_SEC="${POLAR_IHEALTH_LONG_LIVED_SEC:-172800}"
typeset -g IMSG_MIN_VERSION="${POLAR_IHEALTH_IMSG_MIN_VERSION:-0.14.1}"
typeset -g DRY_RUN="${POLAR_IHEALTH_DRY_RUN:-0}"
typeset -g FAST="${POLAR_IHEALTH_FAST:-0}"
typeset -g PROCTAB="${POLAR_IHEALTH_PROCTAB:-}"
typeset -g HARNESS_DIR="${POLAR_IHEALTH_HARNESS_DIR:-}"
typeset -g NOW_OVERRIDE="${POLAR_IHEALTH_NOW:-}"

# Read-only Apple Event. Never a Messages send.
typeset -g AE_PROBE_SCRIPT='tell application "Messages" to get name'
typeset -g AE_QUIT_SCRIPT='tell application "Messages" to quit'

typeset -g EXPECTED_HOSTNAME="Rico.local"
typeset -g EXPECTED_LOCAL_HOSTNAME="Rico"

typeset -ga ACTIONS=()
typeset -ga HUNG_OSASCRIPT_JSON=()
typeset -ga HUNG_IMSG_JSON=()
typeset -ga HUNG_OSA_PIDS=()
typeset -ga HUNG_IMSG_PIDS=()

typeset -g CHECKED_AT="" HOSTNAME_VALUE="" LOCAL_HOSTNAME_VALUE="" NOTE=""
typeset -g HEALTH_STDOUT="" HEALTH_STDERR=""
typeset -g AE_RESULT="unrun" AE_AFTER="" AE_FINAL="unrun"
typeset -g AE_MS=0
typeset -g MSG_RUNNING=0 MSG_PID="null" MSG_AGE="null" MSG_LONG_LIVED=0
typeset -g WEDGE_AE_DEAF=0 WEDGE_LONG=0
typeset -g IMSG_PRESENT=0 IMSG_VERSION="" IMSG_VERSION_OK=0 IMSG_RUNS=0
typeset -g PREV_AE="" PREV_PID=""

json_str() {
  local s=${1:-}
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  print -rn -- "\"$s\""
}

json_bool() {
  if [[ "${1:-0}" == "1" || "${1:-}" == "true" ]]; then
    print -rn -- true
  else
    print -rn -- false
  fi
}

health_sleep() {
  if [[ "$FAST" == "1" ]]; then
    return 0
  fi
  sleep "$1"
}

now_iso() {
  if [[ -n "$NOW_OVERRIDE" ]]; then
    print -r -- "$NOW_OVERRIDE"
    return
  fi
  date -u +%Y-%m-%dT%H:%M:%SZ
}

now_ms() {
  if [[ -n "${EPOCHREALTIME:-}" ]]; then
    local sec frac
    sec=${EPOCHREALTIME%%.*}
    frac=${EPOCHREALTIME#*.}000
    print -r -- $(( sec * 1000 + ${frac[1,3]} ))
    return 0
  fi
  print -r -- $(( $(date +%s) * 1000 ))
}

log_line() {
  local msg="$1"
  local line
  line="$(now_iso) $msg"
  print -r -- "$line"
  if [[ -n "$LOG_PATH" ]]; then
    mkdir -p "${LOG_PATH:h}" 2>/dev/null || true
    print -r -- "$line" >> "$LOG_PATH" || true
  fi
}

etime_to_seconds() {
  local e=${1:-0}
  local days=0 rest=$e
  if [[ "$e" == *-* ]]; then
    days=${e%%-*}
    rest=${e#*-}
  fi
  local -a t
  t=("${(@s/:/)rest}")
  local sec=0
  if (( $#t == 3 )); then
    sec=$(( t[1] * 3600 + t[2] * 60 + t[3] ))
  elif (( $#t == 2 )); then
    sec=$(( t[1] * 60 + t[2] ))
  else
    sec=${t[1]:-0}
  fi
  print -r -- $(( days * 86400 + sec ))
}

version_ge() {
  local a=${1:-0} b=${2:-0}
  a=${a#v}
  b=${b#v}
  local -a aa bb
  aa=("${(@s:.:)a}")
  bb=("${(@s:.:)b}")
  local i x y
  for i in 1 2 3; do
    x=${aa[$i]:-0}
    y=${bb[$i]:-0}
    x=${x%%[^0-9]*}
    y=${y%%[^0-9]*}
    [[ -z "$x" ]] && x=0
    [[ -z "$y" ]] && y=0
    if (( x > y )); then
      return 0
    fi
    if (( x < y )); then
      return 1
    fi
  done
  return 0
}

extract_version() {
  local text=$1
  local match
  match=$(print -r -- "$text" | grep -Eo '[0-9]+\.[0-9]+([.][0-9]+)?' | head -n 1 || true)
  print -r -- "${match:-}"
}

list_processes() {
  if [[ -n "$PROCTAB" && -f "$PROCTAB" ]]; then
    cat "$PROCTAB"
    return 0
  fi
  "$HEALTH_BIN_PS" -axo pid=,ppid=,etime=,command=
}

filter_proctab_pid() {
  local pid=$1
  if [[ -z "$PROCTAB" || ! -f "$PROCTAB" ]]; then
    return 0
  fi
  local tmp="${PROCTAB}.tmp"
  awk -v pid="$pid" '$1 != pid { print }' "$PROCTAB" > "$tmp"
  mv "$tmp" "$PROCTAB"
}

append_proctab_messages() {
  if [[ -z "$PROCTAB" ]]; then
    return 0
  fi
  print -r -- "4242 1 00:01 /System/Applications/Messages.app/Contents/MacOS/Messages" >> "$PROCTAB"
}

is_messages_app() {
  local cmd=$1
  [[ "$cmd" == *osascript* ]] && return 1
  [[ "$cmd" == *"/Messages.app/Contents/MacOS/Messages"* ]] && return 0
  local base=${cmd##*/}
  base=${base%% *}
  [[ "$base" == "Messages" ]] && return 0
  return 1
}

is_osascript_cmd() {
  local cmd=$1
  [[ "$cmd" == *osascript* ]]
}

is_imsg_cmd() {
  local cmd=$1
  [[ "$cmd" == *"/imsg "* || "$cmd" == *"/imsg" || "$cmd" == "imsg "* || "$cmd" == "imsg" ]]
}

# Exact argv token match so we detect a running send-subcommand without invoking it.
argv_has_token() {
  local cmd=$1
  local token=$2
  local -a parts
  parts=("${(@s/ /)cmd}")
  local p
  for p in "${parts[@]}"; do
    [[ "$p" == "$token" ]] && return 0
  done
  return 1
}

parent_cmd() {
  local want=$1
  local pid pp etime cmd
  while read -r pid pp etime cmd || [[ -n "${pid:-}" ]]; do
    [[ -z "${pid:-}" ]] && continue
    if [[ "$pid" == "$want" ]]; then
      print -r -- "$cmd"
      return 0
    fi
    pid=""
  done < <(list_processes)
  return 0
}

is_messages_osascript() {
  local ppid=$1
  local cmd=$2
  is_osascript_cmd "$cmd" || return 1
  [[ "$cmd" == *Messages* ]] && return 0
  local pcmd
  pcmd=$(parent_cmd "$ppid" || true)
  if is_imsg_cmd "$pcmd"; then
    return 0
  fi
  return 1
}

messages_row() {
  local pid pp etime cmd
  while read -r pid pp etime cmd || [[ -n "${pid:-}" ]]; do
    [[ -z "${pid:-}" ]] && continue
    if is_messages_app "$cmd"; then
      print -r -- "$pid $etime"
      return 0
    fi
    pid=""
  done < <(list_processes)
  return 0
}

run_with_timeout() {
  local timeout_sec=$1
  shift
  local out_file err_file
  out_file=$(mktemp)
  err_file=$(mktemp)
  "$@" >"$out_file" 2>"$err_file" &
  local pid=$!
  local deadline
  if [[ -n "${EPOCHREALTIME:-}" ]]; then
    deadline=$(( EPOCHREALTIME + timeout_sec ))
  else
    deadline=$(( $(date +%s) + timeout_sec ))
  fi
  while kill -0 "$pid" 2>/dev/null; do
    local now
    if [[ -n "${EPOCHREALTIME:-}" ]]; then
      now=$EPOCHREALTIME
    else
      now=$(date +%s)
    fi
    if (( now >= deadline )); then
      kill -TERM "$pid" 2>/dev/null || true
      sleep 0.2
      kill -KILL "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      HEALTH_STDOUT=$(cat "$out_file" || true)
      HEALTH_STDERR=$(cat "$err_file" || true)
      rm -f "$out_file" "$err_file"
      return 124
    fi
    sleep 0.1
  done
  local rc=0
  wait "$pid" || rc=$?
  HEALTH_STDOUT=$(cat "$out_file" || true)
  HEALTH_STDERR=$(cat "$err_file" || true)
  rm -f "$out_file" "$err_file"
  return $rc
}

osascript_e() {
  local script=$1
  local timeout_sec=$2
  HEALTH_STDOUT=""
  HEALTH_STDERR=""
  run_with_timeout "$timeout_sec" "$HEALTH_BIN_OSASCRIPT" -e "$script"
}

remediate_signal() {
  local sig=$1
  local pid=$2
  if [[ "$DRY_RUN" == "1" ]]; then
    ACTIONS+=("would_kill_${sig}:$pid")
    return 0
  fi
  ACTIONS+=("kill_${sig}:$pid")
  if [[ -n "$HARNESS_DIR" ]]; then
    print -r -- "$sig $pid" >> "$HARNESS_DIR/killed"
  fi
  if [[ -n "$PROCTAB" ]]; then
    filter_proctab_pid "$pid"
    return 0
  fi
  kill -"$sig" "$pid" 2>/dev/null || true
}

host_gate() {
  local hn ln
  hn=$("$HEALTH_BIN_HOSTNAME" 2>/dev/null || true)
  ln=$("$HEALTH_BIN_SCUTIL" --get LocalHostName 2>/dev/null || true)
  HOSTNAME_VALUE=$hn
  LOCAL_HOSTNAME_VALUE=$ln
  typeset -l hn_l ln_l
  hn_l=$hn
  ln_l=$ln
  if [[ "$hn_l" != "rico.local" || "$ln_l" != "rico" ]]; then
    print -r -- "hostname-gate: refusing to run on host=${hn} localHostName=${ln} (want ${EXPECTED_HOSTNAME} / ${EXPECTED_LOCAL_HOSTNAME})" >&2
    return 1
  fi
  return 0
}

collect_hung() {
  HUNG_OSASCRIPT_JSON=()
  HUNG_IMSG_JSON=()
  HUNG_OSA_PIDS=()
  HUNG_IMSG_PIDS=()
  local pid pp etime cmd elapsed
  local send_token=send
  while read -r pid pp etime cmd || [[ -n "${pid:-}" ]]; do
    [[ -z "${pid:-}" ]] && continue
    elapsed=$(etime_to_seconds "$etime")
    if (( elapsed >= HUNG_SEC )); then
      if is_messages_osascript "$pp" "$cmd"; then
        HUNG_OSA_PIDS+=("$pid")
        HUNG_OSASCRIPT_JSON+=("{\"pid\":$pid,\"elapsedSec\":$elapsed}")
      elif is_imsg_cmd "$cmd" && argv_has_token "$cmd" "$send_token"; then
        HUNG_IMSG_PIDS+=("$pid")
        HUNG_IMSG_JSON+=("{\"pid\":$pid,\"elapsedSec\":$elapsed}")
      fi
    fi
    pid=""
  done < <(list_processes)
}

kill_hung() {
  local pid
  collect_hung
  if (( ${#HUNG_OSA_PIDS} > 0 )); then
    for pid in "${HUNG_OSA_PIDS[@]}"; do
      remediate_signal TERM "$pid"
      health_sleep 0.2
      if [[ "$DRY_RUN" != "1" ]]; then
        remediate_signal KILL "$pid"
      fi
    done
  fi
  if (( ${#HUNG_IMSG_PIDS} > 0 )); then
    for pid in "${HUNG_IMSG_PIDS[@]}"; do
      remediate_signal TERM "$pid"
      health_sleep 0.2
      if [[ "$DRY_RUN" != "1" ]]; then
        remediate_signal KILL "$pid"
      fi
    done
  fi
}

ensure_messages_running() {
  local row
  row=$(messages_row || true)
  if [[ -n "$row" ]]; then
    return 0
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    ACTIONS+=("would_launch_messages")
    return 1
  fi
  ACTIONS+=("launched_messages")
  if [[ -n "$HARNESS_DIR" ]]; then
    print -r -- "-g -a Messages" >> "$HARNESS_DIR/open.args"
    append_proctab_messages
    return 0
  fi
  "$HEALTH_BIN_OPEN" -g -a Messages >/dev/null 2>&1 || true
  local i=0
  while (( i < START_WAIT )); do
    row=$(messages_row || true)
    [[ -n "$row" ]] && return 0
    health_sleep 1
    i=$((i + 1))
  done
  return 1
}

quit_messages() {
  local row pid
  row=$(messages_row || true)
  [[ -z "$row" ]] && return 0
  pid=${row%% *}
  if [[ "$DRY_RUN" == "1" ]]; then
    ACTIONS+=("would_quit_messages:$pid")
    return 0
  fi
  ACTIONS+=("quit_messages:$pid")
  osascript_e "$AE_QUIT_SCRIPT" "$QUIT_TIMEOUT" || true
  health_sleep 1
  row=$(messages_row || true)
  if [[ -n "$row" ]]; then
    pid=${row%% *}
    remediate_signal TERM "$pid"
    health_sleep 2
    row=$(messages_row || true)
    if [[ -n "$row" ]]; then
      pid=${row%% *}
      remediate_signal KILL "$pid"
    fi
  fi
  return 0
}

relaunch_messages() {
  if [[ "$DRY_RUN" == "1" ]]; then
    ACTIONS+=("would_relaunch_messages")
    return 0
  fi
  quit_messages
  health_sleep 1
  if [[ -n "$HARNESS_DIR" ]]; then
    print -r -- "-g -a Messages" >> "$HARNESS_DIR/open.args"
    append_proctab_messages
    ACTIONS+=("relaunched_messages")
    return 0
  fi
  "$HEALTH_BIN_OPEN" -g -a Messages >/dev/null 2>&1 || true
  local i=0 row
  while (( i < START_WAIT )); do
    row=$(messages_row || true)
    if [[ -n "$row" ]]; then
      ACTIONS+=("relaunched_messages")
      return 0
    fi
    health_sleep 1
    i=$((i + 1))
  done
  ACTIONS+=("relaunch_messages_failed")
  return 1
}

probe_ae() {
  local start end rc=0
  start=$(now_ms)
  osascript_e "$AE_PROBE_SCRIPT" "$AE_TIMEOUT" || rc=$?
  end=$(now_ms)
  AE_MS=$(( end - start ))
  if (( AE_MS < 0 )); then
    AE_MS=0
  fi
  if (( rc == 124 )); then
    AE_RESULT="timeout"
    return 1
  fi
  if (( rc != 0 )); then
    AE_RESULT="fail"
    return 1
  fi
  local out=${HEALTH_STDOUT//$'\n'/}
  if [[ -z "$out" ]]; then
    AE_RESULT="fail"
    return 1
  fi
  AE_RESULT="ok"
  return 0
}

check_imsg() {
  IMSG_PRESENT=0
  IMSG_VERSION=""
  IMSG_VERSION_OK=0
  IMSG_RUNS=0
  if [[ ! -e "$HEALTH_BIN_IMSG" ]]; then
    NOTE="${NOTE}imsg missing at ${HEALTH_BIN_IMSG}. "
    return 1
  fi
  IMSG_PRESENT=1
  local rc=0
  HEALTH_STDOUT=""
  HEALTH_STDERR=""
  run_with_timeout 5 "$HEALTH_BIN_IMSG" --version || rc=$?
  if (( rc != 0 && rc != 124 )); then
    rc=0
    run_with_timeout 5 "$HEALTH_BIN_IMSG" --help || rc=$?
  fi
  if (( rc == 0 )); then
    IMSG_RUNS=1
  elif (( rc == 124 )); then
    NOTE="${NOTE}imsg no-send command timed out. "
  else
    NOTE="${NOTE}imsg no-send command failed. "
  fi
  IMSG_VERSION=$(extract_version "$HEALTH_STDOUT $HEALTH_STDERR")
  if [[ -n "$IMSG_VERSION" ]] && version_ge "$IMSG_VERSION" "$IMSG_MIN_VERSION"; then
    IMSG_VERSION_OK=1
  else
    NOTE="${NOTE}imsg version ${IMSG_VERSION:-unknown} < ${IMSG_MIN_VERSION}. "
    IMSG_VERSION_OK=0
  fi
  if (( IMSG_PRESENT == 1 && IMSG_RUNS == 1 && IMSG_VERSION_OK == 1 )); then
    return 0
  fi
  return 1
}

read_prev_ae() {
  PREV_AE=""
  PREV_PID=""
  if [[ ! -f "$STATE_PATH" ]]; then
    return 0
  fi
  local raw
  raw=$(cat "$STATE_PATH" || true)
  PREV_AE=$(print -r -- "$raw" | tr '\n' ' ' | sed -n 's/.*"lastAeResult": *"\([^"]*\)".*/\1/p' | head -n 1 || true)
  PREV_PID=$(print -r -- "$raw" | tr '\n' ' ' | sed -n 's/.*"pid": *\([0-9][0-9]*\).*/\1/p' | head -n 1 || true)
}

join_json_array() {
  if (( $# == 0 )); then
    print -r -- "[]"
    return
  fi
  local i s="["
  for i in {1..$#}; do
    (( i > 1 )) && s+=","
    s+="${argv[i]}"
  done
  s+="]"
  print -r -- "$s"
}

join_actions_json() {
  if (( $# == 0 )); then
    print -r -- "[]"
    return
  fi
  local i s="["
  for i in {1..$#}; do
    (( i > 1 )) && s+=","
    s+=$(json_str "${argv[i]}")
  done
  s+="]"
  print -r -- "$s"
}

write_state() {
  local ok=$1
  mkdir -p "${STATE_PATH:h}" 2>/dev/null || true
  local hung_osa hung_imsg actions_json
  if (( ${#HUNG_OSASCRIPT_JSON} > 0 )); then
    hung_osa=$(join_json_array "${HUNG_OSASCRIPT_JSON[@]}")
  else
    hung_osa="[]"
  fi
  if (( ${#HUNG_IMSG_JSON} > 0 )); then
    hung_imsg=$(join_json_array "${HUNG_IMSG_JSON[@]}")
  else
    hung_imsg="[]"
  fi
  if (( ${#ACTIONS} > 0 )); then
    actions_json=$(join_actions_json "${ACTIONS[@]}")
  else
    actions_json="[]"
  fi
  local tmp="${STATE_PATH}.tmp"
  cat > "$tmp" <<EOF
{
  "schemaVersion": 1,
  "checkedAt": $(json_str "$CHECKED_AT"),
  "hostname": $(json_str "$HOSTNAME_VALUE"),
  "localHostName": $(json_str "$LOCAL_HOSTNAME_VALUE"),
  "ok": $(json_bool "$ok"),
  "sentMessage": false,
  "openclaw": "untouched",
  "dryRun": $(json_bool "$DRY_RUN"),
  "messages": {
    "running": $(json_bool "$MSG_RUNNING"),
    "pid": ${MSG_PID},
    "ageSec": ${MSG_AGE},
    "longLived": $(json_bool "$MSG_LONG_LIVED")
  },
  "aeProbe": {
    "result": $(json_str "$AE_RESULT"),
    "ms": ${AE_MS},
    "afterRemediation": $(json_str "$AE_AFTER")
  },
  "lastAeResult": $(json_str "$AE_FINAL"),
  "imsg": {
    "path": $(json_str "$HEALTH_BIN_IMSG"),
    "present": $(json_bool "$IMSG_PRESENT"),
    "version": $(json_str "$IMSG_VERSION"),
    "versionOk": $(json_bool "$IMSG_VERSION_OK"),
    "runsNoSend": $(json_bool "$IMSG_RUNS")
  },
  "hung": {
    "osascript": $hung_osa,
    "imsgSend": $hung_imsg
  },
  "wedge": {
    "aeDeaf": $(json_bool "$WEDGE_AE_DEAF"),
    "longLivedAndLastAeFailed": $(json_bool "$WEDGE_LONG")
  },
  "actions": $actions_json,
  "note": $(json_str "$NOTE")
}
EOF
  mv "$tmp" "$STATE_PATH"
}

usage() {
  print -r -- "Usage: polar-imessage-health.zsh [--dry-run]"
  print -r -- "Original Rico only. Read-only Messages AE probe. Never sends."
}

refresh_messages_fields() {
  local row etime
  row=$(messages_row || true)
  if [[ -z "$row" ]]; then
    MSG_RUNNING=0
    MSG_PID="null"
    MSG_AGE="null"
    MSG_LONG_LIVED=0
    return 1
  fi
  MSG_RUNNING=1
  MSG_PID=${row%% *}
  etime=${row#* }
  etime=${etime%% *}
  MSG_AGE=$(etime_to_seconds "$etime")
  if (( MSG_AGE >= LONG_LIVED_SEC )); then
    MSG_LONG_LIVED=1
  else
    MSG_LONG_LIVED=0
  fi
  return 0
}

main() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --dry-run|-n) DRY_RUN=1 ;;
      --help|-h) usage; return 0 ;;
      *)
        usage >&2
        return 3
        ;;
    esac
  done

  CHECKED_AT=$(now_iso)
  ACTIONS=()
  NOTE=""

  if ! host_gate; then
    return 1
  fi

  read_prev_ae
  kill_hung

  if ! refresh_messages_fields; then
    ensure_messages_running || true
    refresh_messages_fields || true
  fi

  local imsg_ok=0
  if check_imsg; then
    imsg_ok=1
  fi

  local ae_ok=0
  if [[ "$MSG_RUNNING" == "1" ]]; then
    if probe_ae; then
      ae_ok=1
    else
      WEDGE_AE_DEAF=1
    fi
  else
    AE_RESULT="messages_not_running"
    WEDGE_AE_DEAF=1
  fi

  if [[ "$MSG_LONG_LIVED" == "1" && -n "$PREV_AE" && "$PREV_AE" != "ok" ]]; then
    WEDGE_LONG=1
  fi

  if [[ "$ae_ok" != "1" ]]; then
    relaunch_messages || true
    refresh_messages_fields || true
    if probe_ae; then
      ae_ok=1
      AE_AFTER="ok"
      WEDGE_AE_DEAF=0
    else
      AE_AFTER="$AE_RESULT"
      NOTE="${NOTE}AE still failed after Messages relaunch; COS uses imsg, not restarting OpenClaw. "
    fi
  fi

  if [[ "$ae_ok" == "1" ]]; then
    AE_FINAL="ok"
  else
    AE_FINAL="${AE_AFTER:-$AE_RESULT}"
  fi

  local ok=0
  if [[ "$ae_ok" == "1" && "$imsg_ok" == "1" ]]; then
    ok=1
  fi

  write_state "$ok"
  log_line "host=${HOSTNAME_VALUE} ok=${ok} ae=${AE_FINAL} aeMs=${AE_MS} messagesPid=${MSG_PID} ageSec=${MSG_AGE} longLived=${MSG_LONG_LIVED} imsg=${IMSG_VERSION:-missing} hungOsa=${#HUNG_OSASCRIPT_JSON} hungImsg=${#HUNG_IMSG_JSON} dryRun=${DRY_RUN} sentMessage=false openclaw=untouched actions=${(j:,:)ACTIONS}"

  if [[ "$ok" == "1" ]]; then
    return 0
  fi
  return 2
}

if [[ "${POLAR_IHEALTH_SOURCED:-0}" != "1" ]]; then
  main "$@"
  exit $?
fi
