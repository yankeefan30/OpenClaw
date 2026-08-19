#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import {
  DEFAULT_BIND_HOST,
  DEFAULT_PORT,
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  LOCAL_TOOL_NAMES,
  PRESSMASTER_RESOURCE,
  SERVER_NAME,
  SERVER_VERSION,
} from "./constants.mjs";
import { bundleFromEnv } from "./credentials.mjs";
import { publicError } from "./errors.mjs";
import { assertOriginalRicoHost, inspectHost } from "./hostname.mjs";
import { createHttpServer } from "./http-server.mjs";
import { MacOSPressmasterCredentialProvider } from "./keychain.mjs";
import { RicoPressmasterMcpServer } from "./mcp-server.mjs";
import { runLogin } from "./oauth.mjs";
import { serveStdio } from "./stdio.mjs";
import { createTokenSource, PressmasterUpstream } from "./upstream.mjs";

export async function main(argv = process.argv.slice(2), deps = {}) {
  if (argv.includes("--help") || argv.includes("-h")) {
    (deps.stdout ?? process.stdout).write(usage());
    return;
  }
  if (argv.length === 1 && argv[0] === "--selftest") {
    (deps.stdout ?? process.stdout).write(`${JSON.stringify({
      ok: true,
      server: SERVER_NAME,
      version: SERVER_VERSION,
      transport: ["stdio", "streamable-http"],
      bind: DEFAULT_BIND_HOST,
      port: DEFAULT_PORT,
      hostGate: "Rico.local or LocalHostName Rico",
      auth: ["keychain", "env"],
      keychainService: KEYCHAIN_SERVICE,
      keychainAccount: KEYCHAIN_ACCOUNT,
      upstream: PRESSMASTER_RESOURCE,
      tools: LOCAL_TOOL_NAMES,
      livePublish: false,
      networkCallsPerformed: 0,
    }, null, 2)}\n`);
    return;
  }

  const hostIdentity = await assertOriginalRicoHost(deps.inspectHost ?? inspectHost);

  if (argv.length === 1 && argv[0] === "--login") {
    const keychain = deps.keychain ?? new MacOSPressmasterCredentialProvider();
    await runLogin({
      fetchImpl: deps.fetchImpl ?? fetch,
      openUrl: deps.openUrl,
      writeBundle: (bundle) => keychain.replaceBundle(bundle),
      listen: deps.listen,
      stdout: deps.stdout ?? process.stdout,
    });
    return;
  }

  if (argv.length === 1 && argv[0] === "--stdio") {
    const runtime = await createRuntime({ hostIdentity, deps });
    await serveStdio({
      mcpServer: new RicoPressmasterMcpServer({ runtime }),
      input: deps.stdin,
      output: deps.stdout,
    });
    return;
  }

  if (argv.length !== 0) {
    (deps.stderr ?? process.stderr).write(usage());
    process.exitCode = 64;
    return;
  }

  const runtime = await createRuntime({ hostIdentity, deps });
  const http = createHttpServer({
    mcpServer: new RicoPressmasterMcpServer({ runtime }),
    host: DEFAULT_BIND_HOST,
    port: portFromEnv(deps.env ?? process.env),
  });
  const address = await http.listen();
  const stdout = deps.stdout ?? process.stdout;
  stdout.write(`Rico Pressmaster MCP listening on http://${DEFAULT_BIND_HOST}:${address.port}/mcp\n`);
  stdout.write("Bind: loopback only. Hostname-gated to original Rico. This is not the hosted Pressmaster OAuth connector.\n");
  return http;
}

export async function createRuntime({ hostIdentity, deps = {} } = {}) {
  const env = deps.env ?? process.env;
  const envBundle = bundleFromEnv(env);
  const keychain = deps.keychain ?? new MacOSPressmasterCredentialProvider();
  const keychainStatus = envBundle ? { available: false, source: "none" } : await keychain.status();
  const authStatus = envBundle
    ? { available: true, source: "env" }
    : { available: keychainStatus.available, source: keychainStatus.available ? "keychain" : "none" };

  let upstream = deps.upstream ?? null;
  if (!upstream && authStatus.available) {
    const tokenSource = createTokenSource({
      envBundle,
      keychain: envBundle ? null : keychain,
      refreshFn: deps.refreshFn,
    });
    upstream = new PressmasterUpstream({
      tokenSource,
      fetchImpl: deps.fetchImpl ?? fetch,
    });
  }

  return {
    hostIdentity,
    authStatus,
    upstream,
    keychain,
    probeOfficial: deps.probeOfficial !== false,
  };
}

function portFromEnv(env) {
  const raw = env.RICO_PRESSMASTER_MCP_PORT;
  if (raw == null || raw === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("RICO_PRESSMASTER_MCP_PORT is invalid.");
  }
  return port;
}

function usage() {
  return `Usage: node index.mjs [--selftest | --login | --stdio]

Rico-local Pressmaster MCP. Hostname-gated to original Rico (Rico.local / LocalHostName Rico).
--login runs Pressmaster OAuth (PKCE + dynamic client registration) and stores the bundle in Keychain.
--stdio is the Polar local MCP command. Default binds ${DEFAULT_BIND_HOST}:${DEFAULT_PORT}/mcp.
Does not use Grok Bot's hosted Pressmaster OAuth connector.
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const published = publicError(error);
    process.stderr.write(`${published.message}\n`);
    process.exitCode = error?.code === "host_refused" ? 78 : 1;
  });
}

export { usage };
