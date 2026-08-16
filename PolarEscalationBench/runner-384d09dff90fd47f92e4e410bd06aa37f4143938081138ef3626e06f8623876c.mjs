#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const NODE = "/opt/homebrew/bin/node";
const TARGET = "/Users/alan/OpenClawStudio/PolarEscalationBench/runner-b7af3ac132fa5d8d6d203b27fb395dfeb10b78298e832274820cdac99623bc63.mjs";
const TARGET_HASH = "c97c3f7ff2a778f907200160eaf3a891d5334d9c6448ebd707b2a889bc774e13";
const ALLOWED = new Set(["next", "complete", "renew", "defer"]);

function fail(code) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: code })}\n`);
  process.exit(1);
}

if (process.argv.length !== 3 || !ALLOWED.has(process.argv[2])) fail("compat_command_invalid");
const stat = fs.lstatSync(TARGET);
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o500) {
  fail("compat_target_invalid");
}
if (typeof process.getuid === "function" && stat.uid !== process.getuid()) fail("compat_target_invalid");
if (fs.realpathSync(TARGET) !== TARGET) fail("compat_target_invalid");
const actualHash = crypto.createHash("sha256").update(fs.readFileSync(TARGET)).digest("hex");
if (!crypto.timingSafeEqual(Buffer.from(actualHash, "hex"), Buffer.from(TARGET_HASH, "hex"))) {
  fail("compat_target_hash_mismatch");
}

const child = spawnSync(NODE, [TARGET, process.argv[2]], {
  cwd: "/Users/alan/OpenClawStudio/PolarEscalationBench",
  env: { HOME: "/Users/alan", LANG: "C", PATH: "/usr/bin:/bin" },
  stdio: "inherit",
});
if (child.error) fail("compat_spawn_failed");
if (child.signal) fail("compat_child_signaled");
process.exit(Number.isInteger(child.status) ? child.status : 1);
