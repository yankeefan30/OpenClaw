#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { defaultStateDirectory, OFFICIAL_LINKS, SERVER_NAME, SERVER_VERSION } from "./constants.mjs";
import { MacOSOpenTableCredentialProvider } from "./keychain.mjs";
import { StrictMcpServer } from "./mcp-server.mjs";
import { OfficialOpenTableClient } from "./official-client.mjs";
import { OpenTableRuntime } from "./runtime.mjs";
import { OpenTableStateStore } from "./state-store.mjs";
import { TOOL_DEFINITIONS } from "./tools.mjs";

export function createProductionRuntime() {
  const now = () => new Date();
  const provider = new MacOSOpenTableCredentialProvider();
  const client = new OfficialOpenTableClient({ credentialProvider: provider, now });
  const store = new OpenTableStateStore(defaultStateDirectory(), now);
  return new OpenTableRuntime({ client, store, now });
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === "--selftest") {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      server: SERVER_NAME,
      version: SERVER_VERSION,
      transport: "stdio-jsonrpc",
      tools: TOOL_DEFINITIONS.map((tool) => tool.name),
      officialDocs: OFFICIAL_LINKS.apiDocs,
      networkCallsPerformed: 0,
    }, null, 2)}\n`);
    return;
  }
  if (process.argv.length !== 2) {
    process.stderr.write("Usage: openclaw-opentable-mcp [--selftest]\n");
    process.exitCode = 64;
    return;
  }
  const server = new StrictMcpServer({ runtime: createProductionRuntime() });
  await server.start();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("OpenTable MCP failed closed.\n");
    process.exitCode = 1;
  });
}
