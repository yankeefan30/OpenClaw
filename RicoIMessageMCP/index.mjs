#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { authorizeRecipient } from "./allowlist.mjs";
import {
  DEFAULT_BIND_HOST,
  DEFAULT_GATEWAY_URL,
  DEFAULT_PORT,
  SERVER_NAME,
  SERVER_VERSION,
  defaultOpenClawConfigPath,
  defaultPolicyPath,
  defaultTokenPath,
  studioSupportDirectory,
} from "./constants.mjs";
import { GatewayClient, assertLoopbackGatewayUrl } from "./gateway.mjs";
import { createHttpServer } from "./http-server.mjs";
import { RicoIMessageMcpServer } from "./mcp-server.mjs";
import { DEFAULT_LOOPBACK_MCP_URL, loopbackMcpUrlFromEnv, proxyStdioToLoopbackHttp } from "./stdio-proxy.mjs";
import { createLocalApps } from "./local-apps.mjs";
import { TOOL_DEFINITIONS } from "./tools.mjs";
import { ensureBearerTokenFile, readBearerToken, readGatewayToken, readOpenClawConfig } from "./secrets.mjs";

export function createRuntime({
  gateway,
  policy,
  channel,
  config,
  localApps,
  emailAuthorizations,
  emailAuthorizationPath,
  policyPath = defaultPolicyPath(),
  supportDirectory = studioSupportDirectory(),
} = {}) {
  return {
    gateway,
    policy,
    channel,
    config,
    localApps,
    emailAuthorizations,
    emailAuthorizationPath,
    policyPath,
    supportDirectory,
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
      transport: "streamable-http",
      bind: DEFAULT_BIND_HOST,
      tools: TOOL_DEFINITIONS.map((tool) => tool.name),
      gateway: DEFAULT_GATEWAY_URL,
      tokenPath: defaultTokenPath(),
      networkCallsPerformed: 0,
    }, null, 2)}\n`);
    return;
  }
  if (argv.length === 1 && argv[0] === "--init-token") {
    const result = ensureBearerTokenFile(tokenPathFromEnv());
    process.stdout.write(`${result.path}\n`);
    return;
  }
  if (argv.length === 1 && argv[0] === "--stdio") {
    const tokenPath = tokenPathFromEnv();
    ensureBearerTokenFile(tokenPath);
    await proxyStdioToLoopbackHttp({ tokenPath, url: loopbackMcpUrlFromEnv() });
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
  const host = DEFAULT_BIND_HOST;
  const port = portFromEnv();
  const gatewayUrl = gatewayUrlFromEnv();
  assertLoopbackGatewayUrl(gatewayUrl);

  const config = readOpenClawConfig(defaultOpenClawConfigPath());
  const runtime = createRuntime({
    gateway: new GatewayClient({ url: gatewayUrl, token: readGatewayToken(defaultOpenClawConfigPath()) }),
    config,
    localApps: createLocalApps(),
  });
  const http = createHttpServer({
    mcpServer: new RicoIMessageMcpServer({ runtime }),
    token,
    host,
    port,
  });
  const address = await http.listen();
  process.stdout.write(`Rico iMessage MCP listening on http://${host}:${address.port}/mcp\n`);
  process.stdout.write(`Bearer token file: ${tokenResult.path}\n`);
  process.stdout.write("Bind: loopback only. This is not the OpenClaw Gateway.\n");
}

function tokenPathFromEnv() {
  return process.env.RICO_IMESSAGE_MCP_TOKEN_FILE || defaultTokenPath();
}

function portFromEnv() {
  const raw = process.env.RICO_IMESSAGE_MCP_PORT;
  if (raw == null || raw === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("RICO_IMESSAGE_MCP_PORT is invalid.");
  }
  return port;
}

function gatewayUrlFromEnv() {
  return process.env.RICO_IMESSAGE_MCP_GATEWAY_URL || DEFAULT_GATEWAY_URL;
}

function usage() {
  return `Usage: node index.mjs [--selftest | --init-token | --stdio]

Loopback streamable-HTTP MCP for Rico iMessage plus local Mail, Calendar, and Outlook.
Binds ${DEFAULT_BIND_HOST}:${DEFAULT_PORT}/mcp. --stdio proxies NDJSON to that URL
after reading the bearer file. Does not expose the OpenClaw Gateway.
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("Rico iMessage MCP failed closed.\n");
    process.exitCode = 1;
  });
}

export { authorizeRecipient, main, DEFAULT_LOOPBACK_MCP_URL };
