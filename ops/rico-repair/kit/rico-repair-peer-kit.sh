#!/bin/bash
# Rico 2 peer kit. Goon may drop this at:
#   /Users/alan/Library/Scripts/rico-repair-peer-kit.sh
#
# Polar's Rico→Rico 2 peer script calls this by name. It restarts the
# pinned /Applications/Grok Bot.app on Rico 2 (Goon-verified: Grok Bot
# 0.20.0, bundle com.anysphere.sand). Do not treat that path as missing.
# Launch only the pinned path. Hostname-gate: LocalHostName == Rico-2.

set -euo pipefail

PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

KIT_NAME="rico-repair-peer-kit"
REQUIRED_HOST="Rico-2"
GROKBOT_APP="/Applications/Grok Bot.app"
GROKBOT_BUNDLE="com.anysphere.sand"

usage() {
  echo "usage: ${KIT_NAME} <grokbot-status|restart-grokbot>" >&2
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
  emit "grokbot_bundle=${GROKBOT_BUNDLE}"
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
  emit "grokbot_bundle=${GROKBOT_BUNDLE}"
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

main() {
  local verb="${1:-}"
  case "$verb" in
    grokbot-status|restart-grokbot)
      ;;
    ""|-h|--help|help)
      usage
      ;;
    *)
      log "refuse: verb not allowlisted"
      usage
      ;;
  esac
  require_host
  "cmd_${verb//-/_}"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
