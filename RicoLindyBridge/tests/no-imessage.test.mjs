import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BRIDGE_TOOLS, FORBIDDEN_TOOLS } from "../constants.mjs";

test("selftest advertises the local-bridge surface and keeps iMessage off", async () => {
  const script = fileURLToPath(new URL("../index.mjs", import.meta.url));
  const result = await runNode([script, "--selftest"]);
  assert.equal(result.status, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.server, "rico-lindy-bridge");
  assert.equal(body.path, "/lindy/local-bridge");
  assert.equal(body.imessage, "disabled");
  assert.equal(body.speaker, "lindy");
  assert.deepEqual(body.tools, BRIDGE_TOOLS);
  assert.equal(body.tools.some((name) => FORBIDDEN_TOOLS.includes(name)), false);
  assert.equal(JSON.stringify(body).includes("18789"), false);
});

test("local Outlook draft helper creates a draft and never sends", () => {
  const source = fs.readFileSync(new URL("../../RicoIMessageMCP/local-apps.mjs", import.meta.url), "utf8");
  const draftFn = source.slice(source.indexOf("function outlookDraftScript"), source.indexOf("function appleScriptNumber"));
  assert.match(draftFn, /make new outgoing message/);
  assert.match(draftFn, /was sent of newMessage/);
  assert.doesNotMatch(draftFn, /send newMessage/);
  assert.doesNotMatch(source, /rico_imessage_send/);
});

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
