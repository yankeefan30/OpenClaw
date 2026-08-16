#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const NODE = "/opt/homebrew/bin/node";
const SANDBOX = "/usr/bin/sandbox-exec";
const DIRECTORY = "/Users/alan/OpenClawStudio/RicoCommsMonitor";
const MONITOR = `${DIRECTORY}/monitor.js`;
const PROFILE = `${DIRECTORY}/read-only.sb`;
const EXPECTED = new Map([
  [MONITOR, "0940ab0dc4da1fe0b8f96ffeb89a223792248dfe3be2da1427dd6d3c20fee4a6"],
  [PROFILE, "f6ed62e012f8900777948691e582777adce5daf6c78b07006668c6e0e8a7befb"],
]);

function fail(code) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: code })}\n`);
  process.exit(1);
}

function verify(file, expectedHash) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("monitor_source_invalid");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) fail("monitor_source_owner_mismatch");
  if (fs.realpathSync(file) !== file) fail("monitor_source_realpath_mismatch");
  const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expectedHash, "hex"))) {
    fail("monitor_source_hash_mismatch");
  }
}

if (process.argv.length !== 2) fail("monitor_runner_arguments_forbidden");
for (const [file, expectedHash] of EXPECTED) verify(file, expectedHash);
const child = spawnSync(SANDBOX, ["-f", PROFILE, NODE, MONITOR], {
  cwd: DIRECTORY,
  env: { HOME: "/Users/alan", LANG: "C", PATH: "/usr/bin:/bin" },
  stdio: "inherit",
});
if (child.error) fail("monitor_runner_spawn_failed");
if (child.signal) fail("monitor_runner_child_signaled");
process.exit(Number.isInteger(child.status) ? child.status : 1);
