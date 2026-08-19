import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { LOCAL_TOOL_NAMES } from "../constants.mjs";
import { createRuntime, main } from "../index.mjs";

test("--selftest does not require Rico and performs no network", async () => {
  const chunks = [];
  await main(["--selftest"], {
    stdout: { write: (chunk) => chunks.push(chunk) },
    inspectHost: async () => ({ hostname: "cursor", localHostName: "" }),
  });
  const body = JSON.parse(chunks.join(""));
  assert.equal(body.ok, true);
  assert.equal(body.networkCallsPerformed, 0);
  assert.equal(body.livePublish, false);
  assert.deepEqual(body.tools, [...LOCAL_TOOL_NAMES]);
});

test("runtime entrypoints abort on Rico 2", async () => {
  await assert.rejects(
    () => main(["--stdio"], {
      inspectHost: async () => ({ hostname: "Rico-2.local", localHostName: "Rico-2" }),
      stdout: { write() {} },
      stderr: { write() {} },
    }),
    { code: "host_refused" },
  );
  await assert.rejects(
    () => main(["--login"], {
      inspectHost: async () => ({ hostname: "Rico-2.local", localHostName: "Rico-2" }),
      stdout: { write() {} },
    }),
    { code: "host_refused" },
  );
});

test("stdio on original Rico serves health without calling Pressmaster publish", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks = [];
  output.on("data", (chunk) => chunks.push(chunk.toString("utf8")));
  const running = main(["--stdio"], {
    inspectHost: async () => ({ hostname: "Rico.local", localHostName: "Rico" }),
    stdin: input,
    stdout: output,
    env: {},
    keychain: { async status() { return { available: false, source: "keychain" }; } },
  });
  input.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
  })}\n`);
  input.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "rico_pressmaster_health", arguments: {} },
  })}\n`);
  input.end();
  await running;
  const printed = chunks.join("");
  assert.match(printed, /rico-pressmaster-mcp/);
  assert.match(printed, /"livePublish":false/);
  assert.ok(!printed.includes("publish_content"));
});

test("createRuntime prefers env bearer over Keychain and does not log it", async () => {
  const runtime = await createRuntime({
    hostIdentity: { hostname: "Rico.local", localHostName: "Rico" },
    deps: {
      env: { PRESSMASTER_ACCESS_TOKEN: "env-access-token-abcdef" },
      keychain: { async status() { throw new Error("keychain should not be required"); } },
      fetchImpl: async () => { throw new Error("no network in this test"); },
      probeOfficial: false,
    },
  });
  assert.equal(runtime.authStatus.source, "env");
  assert.equal(runtime.authStatus.available, true);
  assert.ok(runtime.upstream);
});
