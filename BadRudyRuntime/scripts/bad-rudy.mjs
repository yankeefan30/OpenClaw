#!/usr/bin/env node
import os from "node:os";
import { rollbackBadRudy } from "../rollback.mjs";
import { bundledResourcesRootFromScript, installBadRudy } from "../installer.mjs";
import { readOnlyHostStatus } from "../status.mjs";
import { safeError } from "../errors.mjs";

const args = new Set(process.argv.slice(2));
const known = new Set(["--install-bad-rudy", "--rollback-bad-rudy", "--status", "--dry-run"]);
const unknown = [...args].filter((argument) => !known.has(argument));
const actions = ["--install-bad-rudy", "--rollback-bad-rudy", "--status"].filter((argument) => args.has(argument));
if (unknown.length > 0 || actions.length !== 1 || (args.has("--dry-run") && !args.has("--rollback-bad-rudy"))) {
  process.stderr.write("Usage: bad-rudy.mjs --install-bad-rudy | --status | --rollback-bad-rudy [--dry-run]\n");
  process.exitCode = 2;
} else {
  try {
    const result = args.has("--install-bad-rudy")
      ? installBadRudy({
          homeDirectory: os.homedir(),
          resourcesRoot: bundledResourcesRootFromScript(import.meta.url),
        })
      : args.has("--status")
        ? await readOnlyHostStatus({ homeDirectory: os.homedir() })
        : await rollbackBadRudy({ homeDirectory: os.homedir(), dryRun: args.has("--dry-run") });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(safeError(error))}\n`);
    process.exitCode = 1;
  }
}
