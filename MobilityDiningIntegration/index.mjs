#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { integrationHealth } from "./health.mjs";
import { installIntegration, rollbackIntegration } from "./installer.mjs";

export { integrationHealth } from "./health.mjs";
export { installIntegration, rollbackIntegration } from "./installer.mjs";
export { EtaHandoffOutbox, createReviewedRicoEtaHandoff, validateEtaEvent } from "./eta-handoff.mjs";

function main() {
  const command = process.argv[2] ?? "status";
  let result;
  if (command === "install") result = installIntegration();
  else if (command === "status" || command === "health") result = integrationHealth();
  else if (command === "rollback") result = rollbackIntegration();
  else {
    process.stderr.write("Usage: mobility-dining-integration <install|status|health|rollback>\n");
    process.exitCode = 64;
    return;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.ok === false) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Mobility/dining integration failed closed."}\n`);
    process.exitCode = 1;
  }
}

