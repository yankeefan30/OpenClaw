#!/usr/bin/env node
import process from "node:process";
import { installPrivateGrant } from "../grant.mjs";

if (!process.argv.includes("--stdin-json")) {
  process.stderr.write("Usage: node scripts/install-grant.mjs --stdin-json [--replace]\n");
  process.exitCode = 2;
} else {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  try {
    const target = installPrivateGrant(JSON.parse(text), { replace: process.argv.includes("--replace") });
    process.stdout.write(`Installed private ISTS incident grant at ${target}\n`);
  } catch (error) {
    process.stderr.write(`Grant installation failed: ${String(error?.code ?? error?.message ?? "unknown")}\n`);
    process.exitCode = 1;
  }
}
