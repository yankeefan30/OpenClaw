import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "teardown-lindy.sh");
const source = fs.readFileSync(script, "utf8");

function run({ hostname, dryRun = true }) {
  return spawnSync("sh", [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      RICO_TEARDOWN_HOSTNAME: hostname,
      RICO_TEARDOWN_LINDY_DRY_RUN: dryRun ? "1" : "",
    },
  });
}

test("script refuses every host that is not original Rico.local", () => {
  for (const hostname of ["Rico-2", "Rico 2", "goon", "localhost", "rico.tail434bbe.ts.net"]) {
    const result = run({ hostname });
    assert.equal(result.status, 2, hostname);
    assert.match(result.stderr, /refuse host/u);
    assert.equal(result.stdout.includes("funnel"), false);
  }
});

test("original Rico hosts dry-run the Lindy-only teardown", () => {
  for (const hostname of ["Rico", "Rico.local", "rico", "rico.local"]) {
    const result = run({ hostname });
    assert.equal(result.status, 0, hostname);
    assert.match(result.stdout, /--set-path=\/lindy off/u);
    assert.match(result.stdout, /serve --yes --https=8445 off/u);
    assert.match(result.stdout, /rico-lindy-bridge/u);
    assert.equal(result.stdout.includes("rico-mcp"), false);
    assert.equal(result.stdout.includes("18789"), false);
    assert.equal(result.stdout.includes("18791"), false);
    assert.equal(result.stdout.includes("webhooks/sms"), false);
  }
});

test("script never resets all Funnel or Serve routes", () => {
  assert.match(source, /--set-path=\/lindy off/u);
  assert.match(source, /serve --yes --https=8445 off/u);
  const commands = source.split("\n").filter((line) => /^\s*tailscale /u.test(line));
  assert.ok(commands.some((line) => line.includes("funnel") && line.includes("--set-path=/lindy") && /\boff\b/u.test(line)));
  for (const line of commands) {
    if (line.includes("funnel") && /\boff\b/u.test(line)) assert.match(line, /--set-path=\/lindy/u);
  }
  assert.doesNotMatch(source, /funnel reset/u);
  assert.doesNotMatch(source, /serve reset/u);
  assert.doesNotMatch(source, /--https=8444/u);
  const joined = commands.join("\n");
  assert.doesNotMatch(joined, /18789|18791|rico-mcp|webhooks\/sms/u);
});
