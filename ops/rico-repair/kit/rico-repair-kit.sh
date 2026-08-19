#!/bin/bash
# Rico-side allowlisted repair kit. Polar drops this at:
#   /Users/alan/Library/Scripts/rico-repair-kit.sh
#
# This is NOT an OpenClaw plugin, gateway, or speaker. It never sends mail,
# iMessage, or OpenClaw deliveries. It refuses to run unless LocalHostName is
# exactly Rico (original Mac mini). Never copy this onto Rico-2 or AlanLTE.
#
# Verbs: identity | status | ensure-awake | probe-healthz | restart-gateway
#        probe-lmstudio | restart-lmstudio | grokbot-status | restart-grokbot
#        comms-state | disk

set -euo pipefail

PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

KIT_NAME="rico-repair-kit"
REQUIRED_HOST="Rico"
REQUIRED_UID="501"
GATEWAY_LABEL="ai.openclaw.gateway"
HEALTHZ_URL="http://127.0.0.1:18789/healthz"
LMSTUDIO_URL="http://127.0.0.1:1234/v1/models"
COMMS_STATE="/Users/alan/Documents/Codex/rico-comms-monitor/state.json"
GROKBOT_APP="/Applications/Grok Bot.app"
LMSTUDIO_PIN="${HOME}/.config/rico-repair/lmstudio-app"
CAFFEINATE_SECONDS=180

usage() {
  echo "usage: ${KIT_NAME} <identity|status|ensure-awake|probe-healthz|restart-gateway|probe-lmstudio|restart-lmstudio|grokbot-status|restart-grokbot|comms-state|disk>" >&2
  exit 2
}

log() {
  echo "${KIT_NAME}: $*" >&2
}

emit() {
  printf '%s\n' "$1"
}

require_host() {
  local hn
  if [ ! -x /usr/sbin/scutil ]; then
    log "abort: scutil missing"
    exit 78
  fi
  hn="$(/usr/sbin/scutil --get LocalHostName)"
  if [ "$hn" != "$REQUIRED_HOST" ]; then
    log "abort: LocalHostName=${hn} (required: ${REQUIRED_HOST})"
    emit "host=${hn}"
    emit "result=wrong-host"
    exit 78
  fi
  emit "host=${hn}"
}

require_uid() {
  local uid
  uid="$(/usr/bin/id -u)"
  if [ "$uid" != "$REQUIRED_UID" ]; then
    log "abort: uid=${uid} (required: ${REQUIRED_UID})"
    emit "uid=${uid}"
    emit "result=wrong-uid"
    exit 78
  fi
  emit "uid=${uid}"
}

read_pin() {
  local path="$1"
  if [ -f "$path" ] && [ ! -L "$path" ]; then
    /usr/bin/tr -d '\r\n' < "$path"
  fi
}

sanitize_token() {
  printf '%s' "$1" | /usr/bin/tr -cd 'A-Za-z0-9._/-' | /usr/bin/cut -c1-80
}

probe_http_live() {
  local url="$1"
  local needle="$2"
  local body
  if ! body="$(/usr/bin/curl -sS -m 5 --noproxy '*' "$url" 2>/dev/null)"; then
    echo "down"
    return 1
  fi
  if printf '%s' "$body" | /usr/bin/grep -q "$needle"; then
    echo "live"
    return 0
  fi
  if [ -z "$body" ]; then
    echo "empty"
    return 1
  fi
  echo "unready"
  return 1
}

cmd_identity() {
  emit "uptime=$(/usr/bin/uptime)"
  emit "who=$(/usr/bin/id -un)"
  emit "date=$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)"
}

cmd_ensure_awake() {
  if /usr/bin/pgrep -f '/usr/bin/caffeinate -s' >/dev/null 2>&1; then
    emit "caffeinate=present"
    return 0
  fi
  /usr/bin/caffeinate -s -t "$CAFFEINATE_SECONDS" >/dev/null 2>&1 &
  emit "caffeinate=started"
}

cmd_probe_healthz() {
  local state
  if state="$(probe_http_live "$HEALTHZ_URL" "live")"; then
    emit "healthz=live"
    return 0
  fi
  emit "healthz=${state}"
  return 1
}

gateway_label_loaded() {
  /bin/launchctl print "gui/${REQUIRED_UID}/${GATEWAY_LABEL}" >/dev/null 2>&1
}

cmd_restart_gateway() {
  require_uid
  if ! gateway_label_loaded; then
    log "gateway label gui/${REQUIRED_UID}/${GATEWAY_LABEL} is not installed; will not start a second gateway"
    emit "gateway_label=missing"
    emit "action=restart-gateway"
    emit "result=missing-label"
    return 1
  fi
  emit "gateway_label=loaded"
  emit "action=restart-gateway"
  /bin/launchctl kickstart -k "gui/${REQUIRED_UID}/${GATEWAY_LABEL}"
  /bin/sleep 3
  if cmd_probe_healthz; then
    emit "result=ok"
    return 0
  fi
  emit "result=still-down"
  return 1
}

lmstudio_listen() {
  /usr/sbin/lsof -nP -iTCP:1234 -sTCP:LISTEN 2>/dev/null | /usr/bin/grep -q '127.0.0.1:1234'
}

lmstudio_process() {
  /usr/bin/pgrep -x llmster >/dev/null 2>&1 \
    || /usr/bin/pgrep -f '/Bionic.app/' >/dev/null 2>&1
}

discover_lmstudio_app() {
  local pin candidates
  pin="$(read_pin "$LMSTUDIO_PIN")"
  if [ -n "$pin" ]; then
    if [ -d "$pin" ]; then
      printf '%s' "$pin"
      return 0
    fi
    log "lmstudio pin invalid: ${pin}"
    return 1
  fi
  if [ -d "/Applications/Bionic.app" ]; then
    printf '%s' "/Applications/Bionic.app"
    return 0
  fi
  if [ -x /usr/bin/mdfind ]; then
    candidates="$(/usr/bin/mdfind 'kMDItemFSName == "Bionic.app"' 2>/dev/null | /usr/bin/grep '/Bionic.app$' || true)"
    if [ -n "$candidates" ] && [ "$(printf '%s\n' "$candidates" | /usr/bin/grep -c .)" -eq 1 ]; then
      printf '%s' "$candidates"
      return 0
    fi
    if [ -n "$candidates" ]; then
      log "lmstudio Bionic.app candidates:"
      printf '%s\n' "$candidates" | while IFS= read -r line; do
        log "  ${line}"
      done
      return 1
    fi
  fi
  return 1
}

cmd_probe_lmstudio() {
  local http="down" listen="no" proc="no" app=""
  if /usr/bin/curl -sS -m 5 --noproxy '*' "$LMSTUDIO_URL" >/dev/null 2>&1; then
    http="ok"
  fi
  if lmstudio_listen; then
    listen="yes"
  fi
  if lmstudio_process; then
    proc="yes"
  fi
  app="$(discover_lmstudio_app 2>/dev/null || true)"
  emit "lmstudio_http=${http}"
  emit "lmstudio_listen=${listen}"
  emit "lmstudio_process=${proc}"
  if [ -n "$app" ]; then
    emit "lmstudio_host_app=${app}"
  else
    emit "lmstudio_host_app=unknown"
  fi
  if [ "$listen" = "yes" ] || [ "$proc" = "yes" ]; then
    emit "lmstudio_alive=yes"
    if [ "$http" != "ok" ]; then
      emit "lmstudio=slow-or-unready"
    else
      emit "lmstudio=up"
    fi
    return 0
  fi
  emit "lmstudio_alive=no"
  emit "lmstudio=dead"
  return 1
}

cmd_restart_lmstudio() {
  emit "action=restart-lmstudio"
  if lmstudio_listen || lmstudio_process; then
    log "lmstudio/qwen process is alive; not restarting a healthy or slow server"
    cmd_probe_lmstudio || true
    emit "result=skipped-alive"
    return 0
  fi
  local app
  if ! app="$(discover_lmstudio_app)"; then
    log "Bionic.app not uniquely found; pin ~/.config/rico-repair/lmstudio-app"
    emit "lmstudio_host_app=ambiguous-or-missing"
    emit "result=no-app"
    return 1
  fi
  emit "lmstudio_host_app=${app}"
  /usr/bin/open "$app"
  /bin/sleep 3
  cmd_probe_lmstudio || true
  emit "result=reopened"
}

grokbot_installed() {
  [ -d "$GROKBOT_APP" ]
}

grokbot_running() {
  /usr/bin/pgrep -f '/Applications/Grok Bot.app/' >/dev/null 2>&1 \
    || /usr/bin/pgrep -f '/Library/Application Support/Grok Bot' >/dev/null 2>&1
}

cmd_grokbot_status() {
  local running="missing" installed="no"
  if grokbot_installed; then
    installed="yes"
  fi
  if grokbot_running; then
    running="running"
  fi
  emit "grokbot=${running}"
  emit "grokbot_app=${GROKBOT_APP}"
  emit "grokbot_installed=${installed}"
  if [ "$installed" != "yes" ]; then
    emit "result=not-installed"
    return 1
  fi
  if [ "$running" = "running" ]; then
    return 0
  fi
  return 1
}

quit_grokbot() {
  /usr/bin/pkill -TERM -f '/Applications/Grok Bot.app/' >/dev/null 2>&1 || true
  /usr/bin/pkill -TERM -f '/Library/Application Support/Grok Bot' >/dev/null 2>&1 || true
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if ! grokbot_running; then
      return 0
    fi
    /bin/sleep 1
  done
  /usr/bin/pkill -KILL -f '/Applications/Grok Bot.app/' >/dev/null 2>&1 || true
  /usr/bin/pkill -KILL -f '/Library/Application Support/Grok Bot' >/dev/null 2>&1 || true
  /bin/sleep 1
  if grokbot_running; then
    log "Grok Bot process tree still present after kill"
    return 1
  fi
}

cmd_restart_grokbot() {
  emit "action=restart-grokbot"
  emit "grokbot_app=${GROKBOT_APP}"
  if ! grokbot_installed; then
    log "Grok Bot.app not installed at pinned path; not inventing another app"
    emit "grokbot_installed=no"
    emit "result=not-installed"
    return 1
  fi
  emit "grokbot_installed=yes"
  if grokbot_running; then
    if ! quit_grokbot; then
      emit "result=quit-failed"
      return 1
    fi
    emit "grokbot_quit=ok"
  else
    emit "grokbot_quit=not-running"
  fi
  /usr/bin/open -a "$GROKBOT_APP"
  /bin/sleep 3
  if grokbot_running; then
    emit "grokbot=running"
    emit "result=ok"
    return 0
  fi
  emit "grokbot=missing"
  emit "result=open-failed"
  return 1
}

cmd_comms_state() {
  if [ ! -f "$COMMS_STATE" ] || [ -L "$COMMS_STATE" ]; then
    emit "comms=absent"
    return 0
  fi
  emit "comms=present"
  local age
  age="$(( $(/bin/date +%s) - $(/usr/bin/stat -f %m "$COMMS_STATE") ))"
  emit "comms_age_s=${age}"
  if [ -x /usr/bin/python3 ]; then
    /usr/bin/python3 - "$COMMS_STATE" <<'PY'
import json, sys
path = sys.argv[1]
try:
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
except Exception:
    print("comms_parse=unreadable")
    raise SystemExit(0)
if not isinstance(data, dict):
    print("comms_parse=unreadable")
    raise SystemExit(0)
plane = data.get("control_plane")
if isinstance(plane, dict):
    for key in ("status", "direct_probe_ok", "gateway_ok", "running", "probe_ok", "consecutive_failures"):
        value = plane.get(key)
        if isinstance(value, bool):
            print(f"comms_{key}={'yes' if value else 'no'}")
        elif isinstance(value, (int, str)) and len(str(value)) <= 40:
            print(f"comms_{key}={value}")
else:
    print("comms_control=unknown")
PY
  else
    emit "comms_parse=no-python"
  fi
}

cmd_disk() {
  /bin/df -h / | /usr/bin/awk 'NR==2 {print "disk_root="$0}'
}

cmd_status() {
  cmd_identity
  cmd_ensure_awake
  if gateway_label_loaded; then
    emit "gateway_label=loaded"
  else
    emit "gateway_label=missing"
  fi
  cmd_probe_healthz || true
  cmd_grokbot_status || true
  cmd_probe_lmstudio || true
  cmd_comms_state || true
  cmd_disk || true
}

main() {
  local verb="${1:-}"
  case "$verb" in
    identity|status|ensure-awake|probe-healthz|restart-gateway|probe-lmstudio|restart-lmstudio|grokbot-status|restart-grokbot|comms-state|disk)
      ;;
    ""|-h|--help|help)
      usage
      ;;
    *)
      log "refuse: verb not allowlisted: $(sanitize_token "$verb")"
      usage
      ;;
  esac
  require_host
  "cmd_${verb//-/_}"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
