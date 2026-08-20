#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "./config/env.ts";
import { importDailyPayload, validatePayload } from "./importer/dailyImport.ts";
import { Logger } from "./utils/logger.ts";

function parseArgs(argv: string[]) {
  const args = {
    file: "" as string,
    dryRun: false,
    validateOnly: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--validate-only") args.validateOnly = true;
    else if (a === "--file" || a === "-f") {
      args.file = argv[++i] ?? "";
    } else if (!a.startsWith("-") && !args.file) {
      args.file = a;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.file) {
    console.error(
      "Usage: npm run import -- --file fixtures/sample-daily-payload.json [--dry-run] [--validate-only]",
    );
    process.exit(2);
  }

  const rawText = await readFile(resolve(args.file), "utf8");
  const raw = JSON.parse(rawText) as unknown;

  if (args.validateOnly) {
    const payload = validatePayload(raw);
    console.log(
      JSON.stringify(
        {
          ok: true,
          run_id: payload.run_id,
          analysis_date: payload.analysis_date,
          people: payload.people.length,
          evidence: payload.evidence.length,
          actions: payload.actions.length,
        },
        null,
        2,
      ),
    );
    return;
  }

  const cfg = loadConfig({
    ...(args.dryRun ? { NOTION_DRY_RUN: "true" } : {}),
  });
  const log = new Logger(cfg.LOG_LEVEL);
  const result = await importDailyPayload(raw, cfg, log);
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "Failed") process.exit(1);
  if (result.status === "Partial") process.exit(3);
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      level: "error",
      message: "importer crashed",
      error: String((err as Error)?.message ?? err),
      stack: (err as Error)?.stack,
    }),
  );
  process.exit(1);
});
