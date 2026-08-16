#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defaultStateDirectory } from "./constants.mjs";
import { DisabledGeocoderAdapter } from "./geocoder.mjs";
import { MacOSUberCredentialProvider } from "./keychain.mjs";
import { PrivateLocationStore } from "./location-store.mjs";
import { StrictMcpServer } from "./mcp-server.mjs";
import { OfficialUberClient } from "./official-client.mjs";
import { PersistentRateLimiter } from "./rate-limiter.mjs";
import { GovernedUberService } from "./service.mjs";
import { UberStateStore } from "./state-store.mjs";
import { TOOL_DEFINITIONS } from "./tools.mjs";

export function createDefaultService() {
  const directory = defaultStateDirectory();
  const credentialProvider = new MacOSUberCredentialProvider();
  const rateLimiter = new PersistentRateLimiter({ directory: path.join(directory, "governance") });
  const client = new OfficialUberClient({ credentialProvider, rateLimiter });
  const store = new UberStateStore(directory);
  const locationStore = new PrivateLocationStore({ directory, ledger: store.ledger });
  const geocoder = new DisabledGeocoderAdapter();
  return new GovernedUberService({ client, store, locationStore, geocoder, rateLimiter });
}

export async function runStdio(service = createDefaultService()) {
  await new StrictMcpServer({ runtime: service }).start();
}

async function selftest() {
  const checks = [];
  checks.push({ name: "model-tools", pass: TOOL_DEFINITIONS.length === 9 });
  checks.push({ name: "monitor-hidden", pass: !TOOL_DEFINITIONS.some((tool) => tool.name.includes("monitor")) });
  checks.push({ name: "coordinates-not-model-authored", pass: !JSON.stringify(TOOL_DEFINITIONS).includes("latitude") && !JSON.stringify(TOOL_DEFINITIONS).includes("longitude") });
  checks.push({ name: "proof-internal", pass: TOOL_DEFINITIONS.filter((tool) => tool.name !== "uber_status").every((tool) => tool.inputSchema.properties.invocation_proof?.["x-openclaw-internal"] === true && !tool.inputSchema.required.includes("invocation_proof")) });
  checks.push({ name: "payment-id-redaction", pass: !JSON.stringify(TOOL_DEFINITIONS).includes("payment_method_id") });
  const provider = new MacOSUberCredentialProvider();
  const keychain = await provider.status();
  checks.push({ name: "keychain", pass: keychain.available, detail: keychain.available ? "configured" : "missing (expected until official OAuth setup)" });
  const pass = checks.every((check) => check.pass || check.name === "keychain");
  process.stdout.write(`${JSON.stringify({ pass, liveRideAttempted: false, liveNetworkAttempted: false, checks })}\n`);
  process.exitCode = pass ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (process.argv.includes("--selftest")) await selftest();
  else await runStdio();
}
