#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const NODE = "/opt/homebrew/bin/node";
const DIRECTORY = "/Users/alan/OpenClawStudio/PolarEscalationBench";
const INDEX = `${DIRECTORY}/index.js`;
const BENCH = `${DIRECTORY}/bench.js`;
const RESULT_CONTRACT = "/Users/alan/OpenClawStudio/RicoEscalationHandoff/result-contract.js";
const RECEIPT = `${DIRECTORY}/.runner-receipt.json`;
const EXPECTED = new Map([
  [INDEX, "ec10327d82741c738156e0042556ce57bf565d548ab9573504a1aa14dffd95f5"],
  [BENCH, "80053913ecef410083d7d89605bdec26155cb034752d9a056611f552fadb96df"],
  [RESULT_CONTRACT, "d31faadbe0bca130f55822ea8edac10405827ee11ae20e0d0d9bdacf9ad69cdd"],
]);
const ALLOWED = new Set(["next", "complete", "renew", "defer"]);

function fail(code, status = 1) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: code })}\n`);
  process.exit(status);
}

function verifySource(file, expectedHash) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("runner_source_invalid");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) fail("runner_source_owner_mismatch");
  if (fs.realpathSync(file) !== file) fail("runner_source_realpath_mismatch");
  const actualHash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(actualHash, "hex"), Buffer.from(expectedHash, "hex"))) {
    fail("runner_source_hash_mismatch");
  }
}

function writeReceipt(value) {
  const directoryStat = fs.lstatSync(DIRECTORY);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) fail("runner_directory_invalid");
  if (typeof process.getuid === "function" && directoryStat.uid !== process.getuid()) fail("runner_directory_owner_mismatch");
  if (fs.realpathSync(DIRECTORY) !== DIRECTORY) fail("runner_directory_realpath_mismatch");
  if (fs.existsSync(RECEIPT)) {
    const current = fs.lstatSync(RECEIPT);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || (current.mode & 0o777) !== 0o600) {
      fail("runner_receipt_invalid");
    }
    if (typeof process.getuid === "function" && current.uid !== process.getuid()) fail("runner_receipt_invalid");
    if (fs.realpathSync(RECEIPT) !== RECEIPT) fail("runner_receipt_invalid");
  }
  const temp = `${RECEIPT}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temp, RECEIPT);
  } catch {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temp); } catch {}
    fail("runner_receipt_write_failed");
  }
}

if (process.argv.length !== 3 || !ALLOWED.has(process.argv[2])) fail("runner_command_invalid");
for (const [file, expectedHash] of EXPECTED) verifySource(file, expectedHash);
const startedAt = new Date().toISOString();
writeReceipt({ version: 1, command: process.argv[2], stage: "started", started_at_utc: startedAt });

const child = spawnSync(NODE, [INDEX, process.argv[2]], {
  cwd: DIRECTORY,
  env: { HOME: "/Users/alan", LANG: "C", PATH: "/usr/bin:/bin" },
  stdio: "inherit",
});
if (child.error) fail("runner_spawn_failed");
if (child.signal) fail("runner_child_signaled", 1);
writeReceipt({
  version: 1,
  command: process.argv[2],
  stage: "finished",
  started_at_utc: startedAt,
  finished_at_utc: new Date().toISOString(),
  exit_code: Number.isInteger(child.status) ? child.status : 1,
});
process.exit(Number.isInteger(child.status) ? child.status : 1);
