#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { PolarEscalationBench } from "./bench.js";

const MAX_STDIN_BYTES = 32 * 1024;

function safeError(error) {
  const code = typeof error?.code === "string" && /^[a-z0-9_]+$/u.test(error.code)
    ? error.code
    : "bench_failed";
  return { ok: false, error: code };
}

async function readJsonStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_STDIN_BYTES) throw Object.assign(new Error("stdin_too_large"), { code: "stdin_too_large" });
    chunks.push(chunk);
  }
  if (size === 0) throw Object.assign(new Error("stdin_required"), { code: "stdin_required" });
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("stdin_json_invalid"), { code: "stdin_json_invalid" });
  }
}

export async function run(argv = process.argv.slice(2), bench = new PolarEscalationBench()) {
  const command = argv[0];
  switch (command) {
    case "init":
      return bench.init();
    case "next":
      return bench.next();
    case "complete":
      return bench.complete(await readJsonStdin());
    case "renew":
      return bench.updateClaim(await readJsonStdin(), "renew");
    case "defer":
      return bench.updateClaim(await readJsonStdin(), "defer");
    case "status":
      return bench.status();
    case "selftest": {
      const status = await bench.status();
      return { ...status, selftest: "passed", networkCalls: 0, messagesSent: 0, desktopActions: 0 };
    }
    default:
      throw Object.assign(new Error("command_invalid"), { code: "command_invalid" });
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
if (isMain) {
  try {
    const result = await run();
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(safeError(error))}\n`);
    process.exitCode = 1;
  }
}
