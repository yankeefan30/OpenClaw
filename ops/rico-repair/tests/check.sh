#!/bin/bash
# Offline safety checks for the Rico 2 hop. No SSH, mail, or iMessage.

set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
HOP="${ROOT}/bin/rico-repair"
KIT="${ROOT}/kit/rico-repair-kit.sh"
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

if bash -n "$HOP" && bash -n "$KIT" && bash -n "$0"; then
  pass "bash -n"
else
  fail "bash -n"
fi

if [ -x "$HOP" ] && [ -x "$KIT" ]; then
  pass "exec bits"
else
  fail "exec bits"
fi

# Patterns are concatenated so this file does not contain the live tokens.
forbidden_re="$(printf '%s' 'im' 'sg |' 'openclaw --' 'deliver|' 'csrutil|' \
  '0\\.0\\.0\\.0|' 'reboot |' 'shutdown |' 'passwd |' 'chat\\.db|' \
  'openclaw\\.json|' 'auth\\.json|' 'pbcopy')"
if grep -E -n "$forbidden_re" "$HOP" "$KIT"; then
  fail "forbidden token in scripts"
else
  pass "no forbidden tokens in scripts"
fi

speaker_re="$(printf '%s' 'Mess' 'ages|' 'Out' 'look|' 'Mail\\.app|' 'say |' 'afplay')"
if grep -E -n "$speaker_re" "$HOP" "$KIT"; then
  fail "speaker/mail token in scripts"
else
  pass "no speaker/mail tokens"
fi

if grep -nE '(^|[[:space:]])openclaw[[:space:]]|/bin/openclaw' "$HOP" "$KIT"; then
  fail "openclaw binary invocation in scripts"
else
  pass "no openclaw binary"
fi

if grep -q 'scutil --get LocalHostName' "$HOP" \
  && grep -q 'scutil --get LocalHostName' "$KIT" \
  && grep -q 'REQUIRED_HOST="Rico"' "$KIT" \
  && grep -q 'HOP_REQUIRED="Rico-2"' "$HOP"; then
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

if grep -q 'PasswordAuthentication=no' "$HOP" && ! grep -Eiq 'password=.+' "$HOP" "$KIT"; then
  pass "no password material"
else
  fail "no password material"
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

if grep -q 'Grok Bot.app' "$KIT" && grep -q 'grokbot-app' "$KIT" && ! grep -q 'Cursor.app' "$KIT"; then
  pass "grokbot exact name / pin"
else
  fail "grokbot exact name / pin"
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

rm -rf "$tmp"

if [ "$failed" -ne 0 ]; then
  echo "rico-repair checks failed"
  exit 1
fi
echo "rico-repair checks passed"
