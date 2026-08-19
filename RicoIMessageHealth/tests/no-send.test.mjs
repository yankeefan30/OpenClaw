import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { PLIST, SCRIPT, makeHarness, runHealth, HEALTHY_PROCTAB } from "./helpers.mjs";

function codeWithoutComments(source) {
  return source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line) && !/^\s*<!--/.test(line))
    .join("\n");
}

test("healthcheck source has no send path", () => {
  const script = fs.readFileSync(SCRIPT, "utf8");
  const plist = fs.readFileSync(PLIST, "utf8");
  const scriptCode = codeWithoutComments(script);
  const combined = `${script}\n${plist}`;

  assert.doesNotMatch(scriptCode, /\bimsg\s+send\b/);
  assert.doesNotMatch(scriptCode, /send --chat-id/);
  assert.doesNotMatch(scriptCode, /chat[_-]id/i);
  assert.doesNotMatch(script, /tell application "Messages" to send/);
  assert.doesNotMatch(script, /\bsend message\b/i);
  assert.doesNotMatch(combined, /chat\.db/);
  assert.doesNotMatch(combined, /allowFrom/);
  assert.doesNotMatch(combined, /Keychain/);
  assert.doesNotMatch(combined, /\+1\d{10}/);
  assert.doesNotMatch(scriptCode, /csrutil\s+disable/);
  assert.doesNotMatch(scriptCode, /tccutil\s+reset/);
  assert.doesNotMatch(scriptCode, /openclaw gateway/);
  assert.doesNotMatch(scriptCode, /launchctl kickstart/);
  assert.doesNotMatch(script, /imsg launch/);
  assert.doesNotMatch(script, /send-rich/);
  assert.match(script, /tell application "Messages" to get name/);
  assert.match(plist, /<string>ai\.polar\.imessage-health<\/string>/);
  assert.match(plist, /<key>Hour<\/key>\s*<integer>6<\/integer>/);
  assert.match(plist, /<key>Minute<\/key>\s*<integer>0<\/integer>/);
  assert.match(plist, /America\/New_York/);
  assert.doesNotMatch(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.doesNotMatch(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
});

test("live run never invokes imsg with a send-subcommand", async (t) => {
  const harness = await makeHarness();
  t.after(() => fs.promises.rm(harness.dir, { recursive: true, force: true }));
  await harness.writeProctab(HEALTHY_PROCTAB);
  const result = await runHealth(harness);
  assert.equal(result.code, 0);
  const args = await harness.readLines("imsg.args");
  assert.equal(args.length, 1);
  assert.equal(args[0], "--version");
  assert.equal(args.some((line) => line.split(/\s+/u).includes("send")), false);
  const scripts = await harness.readLines("osascript.scripts");
  assert.equal(scripts.some((line) => /\bsend\b/i.test(line)), false);
  const state = await harness.readState();
  assert.equal(state.sentMessage, false);
});
