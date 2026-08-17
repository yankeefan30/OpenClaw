#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { DEFAULT_BIND_HOST } from "../RicoIMessageMCP/constants.mjs";
import { ensureBearerTokenFile, readBearerToken } from "../RicoIMessageMCP/secrets.mjs";
import { loadWorkflowAllowlist } from "./allowlist.mjs";
import {
  BRIDGE_PATH,
  BRIDGE_TOOLS,
  DEFAULT_PORT,
  SERVER_NAME,
  SERVER_VERSION,
  defaultAllowlistPath,
  defaultTokenPath,
} from "./constants.mjs";
import { createBridgeHttpServer } from "./http-server.mjs";
import { createBridgeLocalApps, defaultRuntimePaths } from "./tools.mjs";

export function createRuntime(overrides = {}) {
  return {
    ...defaultRuntimePaths(),
    localApps: createBridgeLocalApps(),
    ...overrides,
  };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  if (argv.length === 1 && argv[0] === "--selftest") {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      server: SERVER_NAME,
      version: SERVER_VERSION,
      path: BRIDGE_PATH,
      bind: DEFAULT_BIND_HOST,
      tools: BRIDGE_TOOLS,
      imessage: "disabled",
      speaker: "lindy",
      tokenPath: defaultTokenPath(),
      allowlistPath: defaultAllowlistPath(),
      networkCallsPerformed: 0,
    }, null, 2)}\n`);
    return;
  }
  if (argv.length === 1 && argv[0] === "--init-token") {
    const result = ensureBearerTokenFile(tokenPathFromEnv());
    process.stdout.write(`${result.path}\n`);
    return;
  }
  if (argv.length !== 0) {
    process.stderr.write(usage());
    process.exitCode = 64;
    return;
  }

  const tokenPath = tokenPathFromEnv();
  const tokenResult = ensureBearerTokenFile(tokenPath);
  const token = readBearerToken(tokenResult.path);
  const allowlist = loadWorkflowAllowlist(allowlistPathFromEnv());
  const host = DEFAULT_BIND_HOST;
  const port = portFromEnv();
  const http = createBridgeHttpServer({
    runtime: createRuntime(),
    allowlist,
    token,
    host,
    port,
  });
  const address = await http.listen();
  process.stdout.write(`Rico Lindy local bridge listening on http://${host}:${address.port}${BRIDGE_PATH}\n`);
  process.stdout.write(`Bearer token file: ${tokenResult.path}\n`);
  process.stdout.write("Mail/calendar only. iMessage is disabled. This is not a Rico chat turn.\n");
}

function tokenPathFromEnv() {
  return process.env.RICO_LINDY_BRIDGE_TOKEN_FILE || defaultTokenPath();
}

function allowlistPathFromEnv() {
  return process.env.RICO_LINDY_BRIDGE_ALLOWLIST_FILE || defaultAllowlistPath();
}

function portFromEnv() {
  const raw = process.env.RICO_LINDY_BRIDGE_PORT;
  if (raw == null || raw === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("RICO_LINDY_BRIDGE_PORT is invalid.");
  }
  return port;
}

function usage() {
  return `Usage: node index.mjs [--selftest | --init-token]

Loopback HTTP bridge for Lindy → local Outlook + Calendar.app on this Mac.
POST ${DEFAULT_BIND_HOST}:${DEFAULT_PORT}${BRIDGE_PATH}
Does not expose iMessage, Messages, or a general Rico chat turn.
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("Rico Lindy local bridge failed closed.\n");
    process.exitCode = 1;
  });
}

export { main };
