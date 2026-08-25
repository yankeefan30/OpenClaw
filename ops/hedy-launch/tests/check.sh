#!/bin/bash
# Offline checks for the Hedy launch kit. No SSH, SIP, or live app mutation.

set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
MAC="${ROOT}/bin/hedy-allow-launch"
WIN="${ROOT}/bin/hedy-allow-launch.ps1"
POLICY="${ROOT}/linux/allow-hedy-chrome.json"
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

if bash -n "$MAC" && bash -n "$0"; then
  pass "bash -n"
else
  fail "bash -n"
fi

if [ -x "$MAC" ]; then
  pass "exec bit on Mac launcher"
else
  fail "exec bit on Mac launcher"
fi

if python3 -m json.tool "$POLICY" >/dev/null; then
  pass "chrome policy json"
else
  fail "chrome policy json"
fi

if grep -q '"DefaultPopupsSetting": 1' "$POLICY" \
  && grep -q 'SafeBrowsingAllowlistDomains' "$POLICY" \
  && grep -q 'hedy.ai' "$POLICY" \
  && grep -q 'hedy.bot' "$POLICY" \
  && ! grep -q 'URLAllowlist' "$POLICY"; then
  pass "chrome policy allowlists Hedy hosts"
else
  fail "chrome policy allowlists Hedy hosts"
fi

forbidden_re="$(printf '%s' 'csrutil|' 'spctl --master-disable|' \
  'reboot |' 'shutdown |' '0\\.0\\.0\\.0|' 'pbcopy|' 'im' 'sg |' \
  'chat\\.db|' 'openclaw\\.json|' 'passwd ')"
if grep -E -n "$forbidden_re" "$MAC" "$WIN"; then
  fail "forbidden token in launchers"
else
  pass "no forbidden tokens in launchers"
fi

if grep -q 'com.apple.quarantine' "$MAC" \
  && grep -q 'ditto' "$MAC" \
  && grep -q 'looks_like_hedy' "$MAC"; then
  pass "Mac launcher uses inode copy and Hedy identity check"
else
  fail "Mac launcher uses inode copy and Hedy identity check"
fi

if grep -q 'Add-MpPreference' "$WIN" \
  && grep -q 'Hedy.exe' "$WIN" \
  && grep -q 'Unblock-File' "$WIN"; then
  pass "Windows launcher uses Defender exclusions"
else
  fail "Windows launcher uses Defender exclusions"
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/hedy-launch-test.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

good="$WORK/Hedy.app/Contents"
mkdir -p "$good"
cat >"$good/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Hedy</string>
  <key>CFBundleDisplayName</key>
  <string>Hedy</string>
  <key>CFBundleIdentifier</key>
  <string>bot.hedy.app</string>
</dict>
</plist>
PLIST

out="$("$MAC" --dry-run --app "$WORK/Hedy.app")"
printf '%s\n' "$out" | grep -q 'would-clear-quarantine' \
  && printf '%s\n' "$out" | grep -q 'would-reinode' \
  && printf '%s\n' "$out" | grep -q 'would-open' \
  && pass "dry-run accepts a Hedy bundle" \
  || fail "dry-run accepts a Hedy bundle"

bad="$WORK/NotHedy.app/Contents"
mkdir -p "$bad"
cat >"$bad/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Calendar</string>
  <key>CFBundleIdentifier</key>
  <string>com.apple.iCal</string>
</dict>
</plist>
PLIST

if "$MAC" --dry-run --app "$WORK/NotHedy.app" >/dev/null 2>"$WORK/err"; then
  fail "dry-run rejects a non-Hedy bundle"
else
  grep -q 'refusing non-Hedy bundle' "$WORK/err" \
    && pass "dry-run rejects a non-Hedy bundle" \
    || fail "dry-run rejects a non-Hedy bundle"
fi

if "$MAC" --dry-run --app "$WORK/missing.app" >/dev/null 2>"$WORK/missing-err"; then
  fail "missing app fails closed"
else
  grep -q 'no Hedy.app found' "$WORK/missing-err" \
    && pass "missing app fails closed" \
    || fail "missing app fails closed"
fi

if [ "$failed" -ne 0 ]; then
  echo "hedy-launch checks failed"
  exit 1
fi
echo "hedy-launch checks passed"
