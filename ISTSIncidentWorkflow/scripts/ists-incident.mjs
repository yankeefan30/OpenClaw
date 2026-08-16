#!/usr/bin/env node

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import {
  disableActivation,
  enableActivation,
  installActivation,
} from "../activation.mjs";
import { readActivationStatus, statusSummary } from "../status.mjs";

const MAX_STDIN_BYTES = 2 * 1024 * 1024;

export function runCLI(argv, dependencies = {}) {
  const install = dependencies.installActivation ?? installActivation;
  const enable = dependencies.enableActivation ?? enableActivation;
  const disable = dependencies.disableActivation ?? disableActivation;
  const status = dependencies.readActivationStatus ?? readActivationStatus;
  const readStdin = dependencies.readStdin ?? readBoundedStdin;
  const [command, ...flags] = argv;

  if (command === "status") {
    exactFlags(flags, []);
    const detail = status();
    return { ok: true, summary: statusSummary(detail), detail };
  }
  if (command === "install") {
    exactFlags(flags, ["--stdin-json", "--replace"]);
    if (!flags.includes("--stdin-json")) throw coded("activation_request_stdin_required");
    const request = JSON.parse(readStdin());
    return install(request, { replace: flags.includes("--replace") });
  }
  if (command === "enable") {
    exactFlags(flags, ["--restart-gateway"]);
    return enable({ restartGateway: flags.includes("--restart-gateway") });
  }
  if (command === "disable") {
    exactFlags(flags, ["--restart-gateway"]);
    return disable({ restartGateway: flags.includes("--restart-gateway") });
  }
  if (command === "help" || command === "--help" || command === "-h" || command === undefined) {
    return {
      ok: true,
      usage: [
        "ists-incident status",
        "ists-incident install --stdin-json [--replace]",
        "ists-incident enable [--restart-gateway]",
        "ists-incident disable [--restart-gateway]",
      ],
      note: "Grant data is accepted on stdin only; installation and enablement are separate fail-closed steps.",
    };
  }
  throw coded("cli_command_invalid");
}

function readBoundedStdin() {
  const chunks = [];
  let size = 0;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  while (true) {
    const count = fs.readSync(0, buffer, 0, buffer.length, null);
    if (count === 0) break;
    size += count;
    if (size > MAX_STDIN_BYTES) throw coded("activation_request_too_large");
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  const value = Buffer.concat(chunks).toString("utf8").trim();
  if (!value) throw coded("activation_request_stdin_empty");
  return value;
}

function exactFlags(flags, allowed) {
  const expected = new Set(allowed);
  if (flags.some((flag) => !expected.has(flag)) || new Set(flags).size !== flags.length) {
    throw coded("cli_flags_invalid");
  }
}

function safeCode(error) {
  return String(error?.code ?? error?.name ?? "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "_")
    .slice(0, 80) || "unknown";
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

const invoked = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  try {
    process.stdout.write(`${JSON.stringify(runCLI(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: safeCode(error) })}\n`);
    process.exitCode = 1;
  }
}
