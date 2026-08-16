#!/usr/bin/env node

import process from "node:process";
import { applyLedgerMigration, planLedgerMigration } from "../ledger.mjs";

function safePlan(plan) {
  return {
    status: plan.status,
    format: plan.format,
    recentRecordCount: plan.records,
    importedRequestCount: plan.requestKeys?.length,
    legacyCandidateCount: plan.legacyPaths?.length,
  };
}

try {
  const plan = planLedgerMigration();
  if (!process.argv.includes("--apply")) {
    process.stdout.write(`${JSON.stringify(safePlan(plan), null, 2)}\n`);
  } else {
    const result = applyLedgerMigration(plan);
    process.stdout.write(`Ledger migrated to the private macOS application-support path; legacy source preserved: ${result.preservedLegacy}\n`);
  }
} catch (error) {
  process.stderr.write(`Ledger migration failed closed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
}
