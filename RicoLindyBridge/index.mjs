#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { DEFAULT_BIND_HOST } from "../RicoIMessageMCP/constants.mjs";
import { ensureBearerTokenFile, readBearerToken } from "../RicoIMessageMCP/secrets.mjs";
import { loadWorkflowAllowlist } from "./allowlist.mjs";
import {
  BRIDGE_PATH,
  BRIDGE_TOOLS,
  DEFAULT_PORT,
  MCP_PATH,
  SERVER_NAME,
  SERVER_VERSION,
  defaultAllowlistPath,
  defaultTokenPath,
} from "./constants.mjs";
import { assertOriginalRicoHost } from "./host.mjs";
import { createBridgeHttpServer } from "./http-server.mjs";
import { RicoLindyMcpServer } from "./mcp-server.mjs";
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
      mcpPath: MCP_PATH,
      bind: DEFAULT_BIND_HOST,
      tools: BRIDGE_TOOLS,
      imessage: "disabled",
      speaker: "lindy",
      hostPolicy: "rico.local only",
      funnel: "polar-flip only",
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

  assertOriginalRicoHost();
  const tokenPath = tokenPathFromEnv();
  const tokenResult = ensureBearerTokenFile(tokenPath);
  const token = readBearerToken(tokenResult.path);
  const allowlist = loadWorkflowAllowlist(allowlistPathFromEnv());
  const host = DEFAULT_BIND_HOST;
  const port = portFromEnv();
  const runtime = createRuntime();
  const http = createBridgeHttpServer({
    runtime,
    allowlist,
    mcpServer: new RicoLindyMcpServer({ runtime, allowlist }),
    token,
    host,
    port,
  });
  const address = await http.listen();
  process.stdout.write(`Rico Lindy local bridge listening on http://${host}:${address.port}${BRIDGE_PATH}\n`);
  process.stdout.write(`Lindy MCP (streamable HTTP) on http://${host}:${address.port}${MCP_PATH}\n`);
  process.stdout.write(`Bearer token file: ${tokenResult.path}\n`);
  process.stdout.write("Loopback only. Lindy cannot use 127.0.0.1. Polar flips Tailscale Funnel on Rico.local.\n");
  process.stdout.write("Mail/calendar only. iMessage is disabled. Gateway stays down.\n");
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

Loopback HTTP + streamable-HTTP MCP for Lindy → local Outlook + Calendar.app.
Starts on original Rico.local only. Binds ${DEFAULT_BIND_HOST}:${DEFAULT_PORT}.
REST  ${BRIDGE_PATH}
MCP   ${MCP_PATH}
Lindy cannot call 127.0.0.1. Polar publishes HTTPS via Tailscale Serve/Funnel.
Does not start the OpenClaw Gateway or iMessage.
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("Rico Lindy local bridge failed closed.\n");
    process.exitCode = 1;
  });
}

export { main };
