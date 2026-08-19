#!/bin/bash
# Offline safety checks for the Rico 2 hop. No SSH, mail, or iMessage.

set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
HOP="${ROOT}/bin/rico-repair"
PEER="${ROOT}/bin/rico-repair-peer"
KIT="${ROOT}/kit/rico-repair-kit.sh"
PEER_KIT="${ROOT}/kit/rico-repair-peer-kit.sh"
PLIST="${ROOT}/launchd/ai.polar.rico-repair.plist"
failed=0

pass() { printf 'ok  %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; failed=1; }

assert_eq() {
  local got="$1" want="$2" name="$3"
  if [ "$got" = "$want" ]; then
    pass "$name"
  else
    fail "$name (got [$got] want [$want])"
  fi
}

if bash -n "$HOP" && bash -n "$PEER" && bash -n "$KIT" && bash -n "$PEER_KIT" && bash -n "$0"; then
  pass "bash -n"
else
  fail "bash -n"
fi

if [ -x "$HOP" ] && [ -x "$PEER" ] && [ -x "$KIT" ] && [ -x "$PEER_KIT" ]; then
  pass "exec bits"
else
  fail "exec bits"
fi

# Patterns are concatenated so this file does not contain the live tokens.
forbidden_re="$(printf '%s' 'im' 'sg |' 'openclaw --' 'deliver|' 'csrutil|' \
  '0\\.0\\.0\\.0|' 'reboot |' 'shutdown |' 'passwd |' 'chat\\.db|' \
  'openclaw\\.json|' 'auth\\.json|' 'pbcopy')"
if grep -E -n "$forbidden_re" "$HOP" "$PEER" "$KIT" "$PEER_KIT"; then
  fail "forbidden token in scripts"
else
  pass "no forbidden tokens in scripts"
fi

speaker_re="$(printf '%s' 'Mess' 'ages|' 'Out' 'look|' 'Mail\\.app|' 'say |' 'afplay')"
if grep -E -n "$speaker_re" "$HOP" "$PEER" "$KIT" "$PEER_KIT"; then
  fail "speaker/mail token in scripts"
else
  pass "no speaker/mail tokens"
fi

if grep -nE '(^|[[:space:]])openclaw[[:space:]]|/bin/openclaw' "$HOP" "$PEER" "$KIT" "$PEER_KIT"; then
  fail "openclaw binary invocation in scripts"
else
  pass "no openclaw binary"
fi

if grep -q 'scutil --get LocalHostName' "$HOP" \
  && grep -q 'scutil --get LocalHostName' "$KIT" \
  && grep -q 'REQUIRED_HOST="Rico"' "$KIT" \
  && grep -q 'REQUIRED_HOST="Rico-2"' "$PEER_KIT" \
  && grep -q 'HOP_REQUIRED="Rico-2"' "$HOP" \
  && grep -q 'ORIGIN_REQUIRED="Rico"' "$PEER"; then
  pass "hostname gates present"
else
  fail "hostname gates present"
fi

if grep -q '192.168.4.118' "$HOP" && grep -q 'Rico.local' "$HOP" && grep -q '100.98.73.107' "$HOP"; then
  pass "SSH target order"
else
  fail "SSH target order"
fi

if grep -q 'BatchMode=yes' "$HOP" && grep -q 'IdentitiesOnly=yes' "$HOP" && grep -q 'rico2-to-rico' "$HOP"; then
  pass "SSH options"
else
  fail "SSH options"
fi

if grep -q 'PasswordAuthentication=no' "$HOP" && grep -q 'PasswordAuthentication=no' "$PEER" \
  && ! grep -Eiq 'password=.+' "$HOP" "$PEER" "$KIT" "$PEER_KIT"; then
  pass "no password material"
else
  fail "no password material"
fi

if grep -q '192.168.4.246' "$PEER" && grep -q 'Rico-2.local' "$PEER" && grep -q '100.73.16.116' "$PEER"; then
  pass "peer SSH target order"
else
  fail "peer SSH target order"
fi

if grep -q '<integer>600</integer>' "$PLIST" && grep -q 'watch-once' "$PLIST" \
  && grep -q '/Users/alan/ops/rico-repair/bin/rico-repair' "$PLIST" \
  && grep -q 'WATCH_INTERVAL=600' "$HOP"; then
  pass "LaunchAgent 10-minute interval"
else
  fail "LaunchAgent 10-minute interval"
fi

if grep -q 'Sockets' "$PLIST" || grep -q '0.0.0.0' "$PLIST" || grep -q 'KeepAlive' "$PLIST"; then
  fail "LaunchAgent has no public bind/keepalive"
else
  pass "LaunchAgent has no public bind/keepalive"
fi

if command -v xmllint >/dev/null 2>&1; then
  if xmllint --noout "$PLIST"; then
    pass "plist xml"
  else
    fail "plist xml"
  fi
else
  pass "plist xml skipped (no xmllint)"
fi

if "$HOP" self-check >/tmp/rico-repair-self-check.out; then
  pass "self-check"
else
  fail "self-check"
  cat /tmp/rico-repair-self-check.out || true
fi

# Hop refuses a foreign LocalHostName.
tmp="$(mktemp -d)"
export RICO_REPAIR_TEST=1
export HOME="$tmp"
# shellcheck source=../bin/rico-repair
source "$HOP"
if ( RICO_REPAIR_TEST_HOP=Rico require_hop_host ) >/tmp/rico-repair-host.out 2>&1; then
  fail "hop refuses LocalHostName=Rico"
else
  assert_eq "$?" "78" "hop refuse Rico exit 78"
fi
if ( RICO_REPAIR_TEST_HOP=AlanLTE require_hop_host ) >/tmp/rico-repair-host.out 2>&1; then
  fail "hop refuses AlanLTE"
else
  pass "hop refuses AlanLTE"
fi
if ( RICO_REPAIR_TEST_HOP=Rico-2 require_hop_host ) >/tmp/rico-repair-host.out 2>&1; then
  pass "hop accepts Rico-2"
else
  fail "hop accepts Rico-2"
fi
if ( RICO_REPAIR_TEST_HOP=Rico require_origin_host ) >/tmp/rico-repair-host.out 2>&1; then
  pass "peer command accepts origin Rico"
else
  fail "peer command accepts origin Rico"
fi
if ( RICO_REPAIR_TEST_HOP=Rico-2 require_origin_host ) >/tmp/rico-repair-host.out 2>&1; then
  fail "peer command refuses Rico-2"
else
  pass "peer command refuses Rico-2"
fi

allowlisted_verb status && pass "verb status" || fail "verb status"
allowlisted_verb restart-gateway && pass "verb restart-gateway" || fail "verb restart-gateway"
allowlisted_verb restart-grokbot && pass "verb restart-grokbot" || fail "verb restart-grokbot"
if allowlisted_verb 'rm -rf /'; then
  fail "verb refuse free-form"
else
  pass "verb refuse free-form"
fi
if allowlisted_verb deliver; then
  fail "verb refuse deliver"
else
  pass "verb refuse deliver"
fi

assert_eq "$(kv_get $'healthz=live\ngrokbot=running\n' healthz)" "live" "kv_get healthz"
assert_eq "$(kv_get $'healthz=live\ngrokbot=running\n' grokbot)" "running" "kv_get grokbot"

CONFIG_DIR="${tmp}/.config/rico-repair"
STATE_FILE="${CONFIG_DIR}/state"
ALERT_DIR="${tmp}/.local/state/rico-repair"
ALERT_FILE="${ALERT_DIR}/ALERT"
ALERT_LOG_COPY="${tmp}/Library/Logs/rico-repair-alert"
mkdir -p "$CONFIG_DIR" "$ALERT_DIR" "$(dirname "$ALERT_LOG_COPY")"
now="$(date +%s)"
state_set cooldown_restart-gateway "$((now - 100))"
if cooldown_ok restart-gateway; then
  fail "cooldown blocks 100s"
else
  pass "cooldown blocks 100s"
fi
state_set cooldown_restart-gateway "$((now - 601))"
if cooldown_ok restart-gateway; then
  pass "cooldown allows 601s"
else
  fail "cooldown allows 601s"
fi

# Kit refuses to run here (not Rico; no scutil on Linux).
set +e
"$KIT" identity >/tmp/rico-repair-kit.out 2>/tmp/rico-repair-kit.err
kit_rc=$?
set -e
if [ "$kit_rc" -eq 78 ]; then
  pass "kit refuses non-Rico host"
else
  fail "kit refuses non-Rico host (rc=${kit_rc})"
fi
if "$KIT" 'rm -rf /' >/tmp/rico-repair-kit.out 2>/tmp/rico-repair-kit.err; then
  fail "kit refuse unknown verb"
else
  pass "kit refuse unknown verb"
fi

if grep -q 'kickstart -k' "$KIT" \
  && grep -q 'GATEWAY_LABEL="ai.openclaw.gateway"' "$KIT" \
  && grep -q 'REQUIRED_UID="501"' "$KIT"; then
  pass "gateway kickstart only"
else
  fail "gateway kickstart only"
fi

if grep -q 'GROKBOT_APP="/Applications/Grok Bot.app"' "$KIT" \
  && grep -q 'GROKBOT_APP="/Applications/Grok Bot.app"' "$PEER_KIT" \
  && grep -q 'open -a' "$KIT" && grep -q 'open -a' "$PEER_KIT" \
  && ! grep -q 'osascript' "$KIT" "$PEER_KIT" "$HOP" "$PEER" \
  && ! grep -q 'Cursor.app' "$KIT" "$PEER_KIT" "$HOP" "$PEER"; then
  pass "grokbot pinned path kill+open"
else
  fail "grokbot pinned path kill+open"
fi

if grep -q 'Bionic.app' "$KIT" && grep -q 'llmster' "$KIT" && grep -q 'skipped-alive' "$KIT"; then
  pass "lmstudio conservative reopen"
else
  fail "lmstudio conservative reopen"
fi

if grep -q 'caffeinate -s' "$KIT" && ! grep -q 'pmset' "$KIT" "$HOP"; then
  pass "caffeinate without pmset"
else
  fail "caffeinate without pmset"
fi

rm -f "$STATE_FILE"
rico_remote() {
  printf '%s\n' 'healthz=down' 'grokbot=missing' 'lmstudio_alive=no'
}
if cmd_watch_once >/tmp/rico-repair-watch.out 2>&1; then
  fail "watch-once skips triggers without host=Rico"
else
  pass "watch-once skips triggers without host=Rico"
fi
if [ -z "$(state_get cooldown_restart-gateway)" ]; then
  pass "failed poll does not start cooldown"
else
  fail "failed poll does not start cooldown"
fi
if [ -f "$ALERT_FILE" ] && grep -q 'problem=no-rico-status' "$ALERT_FILE"; then
  pass "unreachable hop writes ALERT"
else
  fail "unreachable hop writes ALERT"
fi

rico_remote() {
  printf '%s\n' 'host=Rico' 'healthz=live' 'grokbot=running' 'lmstudio_alive=yes'
}
cmd_watch_once >/tmp/rico-repair-watch.out 2>&1 || true
if [ ! -f "$ALERT_FILE" ] && [ ! -f "$ALERT_LOG_COPY" ]; then
  pass "healthy tick clears ALERT"
else
  fail "healthy tick clears ALERT"
fi
if [ -z "$(state_get cooldown_restart-gateway)" ]; then
  pass "healthy tick does not run repair"
else
  fail "healthy tick does not run repair"
fi

rico_remote() {
  printf '%s\n' 'host=Rico' 'healthz=down' 'grokbot=running' 'lmstudio_alive=yes' 'result=ok'
}
cmd_watch_once >/tmp/rico-repair-watch.out 2>&1 || true
if [ -f "$ALERT_FILE" ] && grep -q 'actions=restart-gateway' "$ALERT_FILE"; then
  pass "bad tick writes ALERT then runs matching action"
else
  fail "bad tick writes ALERT then runs matching action"
fi
if [ -n "$(state_get cooldown_restart-gateway)" ]; then
  pass "watch-once cooldown after gateway trigger"
else
  fail "watch-once cooldown after gateway trigger"
fi
if [ -z "$(state_get cooldown_restart-grokbot)" ] && [ -z "$(state_get cooldown_restart-lmstudio)" ]; then
  pass "healthy grokbot/lmstudio not restarted"
else
  fail "healthy grokbot/lmstudio not restarted"
fi

rico_remote() {
  printf '%s\n' 'host=Rico' 'healthz=down' 'grokbot=running' 'lmstudio_alive=yes' 'result=ok'
}
before="$(state_get cooldown_restart-gateway)"
cmd_watch_once >/tmp/rico-repair-watch.out 2>&1 || true
after="$(state_get cooldown_restart-gateway)"
if [ "$before" = "$after" ] && [ -f "$ALERT_FILE" ]; then
  pass "cooldown skip still keeps ALERT"
else
  fail "cooldown skip still keeps ALERT"
fi

if "$PEER" self-check >/tmp/rico-repair-peer-self.out; then
  pass "peer self-check"
else
  fail "peer self-check"
  cat /tmp/rico-repair-peer-self.out || true
fi

# shellcheck source=../bin/rico-repair-peer
source "$PEER"
if ( RICO_REPAIR_TEST=1 RICO_REPAIR_TEST_ORIGIN=Rico-2 require_origin_host ) >/tmp/rico-repair-peer-host.out 2>&1; then
  fail "peer script refuses Rico-2 origin"
else
  pass "peer script refuses Rico-2 origin"
fi
if ( RICO_REPAIR_TEST=1 RICO_REPAIR_TEST_ORIGIN=Rico require_origin_host ) >/tmp/rico-repair-peer-host.out 2>&1; then
  pass "peer script accepts Rico origin"
else
  fail "peer script accepts Rico origin"
fi
set +e
RICO_REPAIR_TEST=1 RICO_REPAIR_TEST_ORIGIN=Rico "$PEER" restart-grokbot-on-rico2 >/tmp/rico-repair-peer-run.out 2>/tmp/rico-repair-peer-run.err
peer_rc=$?
set -e
if [ "$peer_rc" -eq 0 ] && grep -q 'host=Rico-2' /tmp/rico-repair-peer-run.out \
  && grep -q '/Applications/Grok Bot.app' /tmp/rico-repair-peer-run.out; then
  pass "peer test restart names Rico-2 and pinned app"
else
  fail "peer test restart names Rico-2 and pinned app"
fi
set +e
"$PEER_KIT" restart-grokbot >/tmp/rico-repair-peer-kit.out 2>/tmp/rico-repair-peer-kit.err
peer_kit_rc=$?
set -e
if [ "$peer_kit_rc" -eq 78 ]; then
  pass "peer kit refuses non-Rico-2 host"
else
  fail "peer kit refuses non-Rico-2 host (rc=${peer_kit_rc})"
fi

rm -rf "$tmp"

if [ "$failed" -ne 0 ]; then
  echo "rico-repair checks failed"
  exit 1
fi
echo "rico-repair checks passed"
