import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { StdioPlaywrightWorkerClient } from "../worker-client.mjs";
import { makeHome, removeHome } from "./helpers.mjs";

test("stdio worker client matches the capture-only contract and never forwards credentials", async (t) => {
  const home = makeHome();
  t.after(() => removeHome(home));
  const nodeExecutable = path.join(home, "node");
  const workerEntry = path.join(home, "index.ts");
  fs.writeFileSync(nodeExecutable, "fake", { mode: 0o700 });
  fs.writeFileSync(workerEntry, "fake", { mode: 0o600 });
  const invocations = [];
  const spawnFn = (file, args, options) => {
    const child = fakeChild((stdin) => {
      invocations.push({ file, args, options, stdin });
      if (args.includes("--status")) {
        return {
          ready: true,
          playwright: "ready",
          ffmpeg: "ready",
          capabilities: { "grok:companions:bad-rudy": true },
        };
      }
      return { ok: true };
    });
    return child;
  };
  const client = new StdioPlaywrightWorkerClient({ nodeExecutable, workerEntry, homeDirectory: home, spawnFn });
  assert.equal((await client.health()).ready, true);
  const secret = Buffer.from("keychain-cookie-bundle");
  await client.capture({
    credential: secret,
    prompt: "Say hello",
    requiredCapability: "grok:companions:bad-rudy",
    format: "mp4",
    maxDurationSeconds: 20,
    exportStill: true,
    retries: 1,
    outputDirectory: path.join(home, "ignored-by-worker"),
    governance: {
      killSwitch: false,
      dryRun: true,
      allowlistReady: true,
      rateLimitApproved: true,
      promptApproval: { approved: true, policyVersion: "policy/v1", sha256: "a".repeat(64) },
      runtimeCapabilityProbe: true,
    },
  });
  const captureInvocation = invocations[1];
  const input = JSON.parse(captureInvocation.stdin);
  assert.equal(input.prompt, "Say hello");
  assert.equal(input.requiredCapability, "grok:companions:bad-rudy");
  assert.equal(input.governance.allowlistReady, true);
  assert.equal(Object.hasOwn(input, "credential"), false);
  assert.equal(Object.hasOwn(input, "recipient"), false);
  assert.equal(Object.hasOwn(input, "delivery"), false);
  assert.equal(captureInvocation.stdin.includes("keychain-cookie-bundle"), false);
  assert.deepEqual(captureInvocation.args.slice(0, 2), ["--experimental-strip-types", workerEntry]);
  assert.equal(Object.values(captureInvocation.options.env).some((value) => String(value).includes("keychain-cookie-bundle")), false);
});

function fakeChild(response) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let input = Buffer.alloc(0);
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      input = Buffer.concat([input, Buffer.from(chunk)]);
      callback();
    },
    final(callback) {
      queueMicrotask(() => {
        const result = response(input.toString("utf8"));
        child.stdout.end(`${JSON.stringify(result)}\n`);
        child.stderr.end();
        child.emit("close", 0);
      });
      callback();
    },
  });
  child.kill = () => true;
  return child;
}
