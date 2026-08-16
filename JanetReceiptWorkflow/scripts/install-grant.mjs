#!/usr/bin/env node

import process from "node:process";
import { defaultGrantPath, installPrivateGrant } from "../grant.mjs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function fromEnvironment() {
  return {
    schemaVersion: 2,
    janetHandle: process.env.JANET_RECEIPT_HANDLE,
    janetEmailRecipient: process.env.JANET_RECEIPT_EMAIL_RECIPIENT,
    alanGmailSender: process.env.JANET_RECEIPT_ALAN_GMAIL_SENDER,
    openCaseOrigin: process.env.JANET_RECEIPT_OPENCASE_ORIGIN,
    heygenOrigin: process.env.JANET_RECEIPT_HEYGEN_ORIGIN,
    capabilityRefs: {
      openCaseSession: process.env.JANET_RECEIPT_OPENCASE_SESSION_REF,
      heygenSession: process.env.JANET_RECEIPT_HEYGEN_SESSION_REF,
      geniusScan: process.env.JANET_RECEIPT_GENIUS_SCAN_REF,
      alanGmail: process.env.JANET_RECEIPT_ALAN_GMAIL_REF,
      cvsOutlook: process.env.JANET_RECEIPT_CVS_OUTLOOK_REF,
    },
  };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const useStdin = args.has("--stdin-json");
  const useEnvironment = args.has("--from-env");
  if (useStdin === useEnvironment) {
    throw new Error("choose exactly one input mode: --stdin-json or --from-env");
  }
  const value = useStdin ? JSON.parse(await readStdin()) : fromEnvironment();
  const installedPath = installPrivateGrant(value, {
    filePath: process.env.JANET_RECEIPT_GRANT_PATH || defaultGrantPath(),
    replace: args.has("--replace"),
  });
  // Deliberately print only the destination. Identity and recipient values
  // must never enter command output, application logs, or the audit ledger.
  process.stdout.write(`Private Janet receipt grant installed at ${installedPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`Grant installation failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
