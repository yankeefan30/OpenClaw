#!/usr/bin/env node
import process from "node:process";
import { installPrivateGrant } from "../grant.mjs";

if (!process.argv.includes("--stdin-json")) {
  process.stderr.write("Refusing command-line identity values. Pipe the grant JSON on stdin and pass --stdin-json.\n");
  process.exitCode = 2;
} else {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("grant input is too large");
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const installed = installPrivateGrant(value, { replace: process.argv.includes("--replace") });
  process.stdout.write(`Installed private grant at ${installed}\n`);
}
