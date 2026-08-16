import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { loopbackMcpUrlFromEnv, proxyStdioToLoopbackHttp } from "../stdio-proxy.mjs";

test("stdio proxy stays on loopback", () => {
  assert.equal(loopbackMcpUrlFromEnv({}), "http://127.0.0.1:18791/mcp");
  assert.equal(loopbackMcpUrlFromEnv({ RICO_IMESSAGE_MCP_URL: "http://127.0.0.1:18791/mcp" }), "http://127.0.0.1:18791/mcp");
  assert.throws(() => loopbackMcpUrlFromEnv({ RICO_IMESSAGE_MCP_URL: "https://rico.tail434bbe.ts.net:8444/mcp" }), { code: "bind_refused" });
  assert.throws(() => loopbackMcpUrlFromEnv({ RICO_IMESSAGE_MCP_URL: "http://0.0.0.0:18791/mcp" }), { code: "bind_refused" });
});

test("stdio proxy forwards JSON-RPC to loopback HTTP and never echoes the bearer", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks = [];
  output.on("data", (chunk) => chunks.push(chunk.toString("utf8")));
  const calls = [];
  const done = proxyStdioToLoopbackHttp({
    input,
    output,
    url: "http://127.0.0.1:18791/mcp",
    readToken: () => "test-bearer-token",
    fetchImpl: async (url, init) => {
      calls.push({ url, authorization: init.headers.Authorization, body: init.body });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "mcp-session-id": "session-1" }),
        async json() {
          return {
            jsonrpc: "2.0",
            id: 1,
            result: { tools: [{ name: "rico_imessage_health" }] },
          };
        },
      };
    },
  });

  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`);
  input.end();
  await done;

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:18791/mcp");
  assert.equal(calls[0].authorization, "Bearer test-bearer-token");
  const printed = chunks.join("");
  assert.match(printed, /rico_imessage_health/);
  assert.ok(!printed.includes("test-bearer-token"));
  assert.ok(!printed.includes("Authorization"));
});

test("stdio proxy maps missing token to unauthorized without leaking paths", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks = [];
  output.on("data", (chunk) => chunks.push(chunk.toString("utf8")));
  const done = proxyStdioToLoopbackHttp({
    input,
    output,
    readToken: () => {
      const error = new Error("Bearer token is unavailable.");
      error.code = "unauthorized";
      throw error;
    },
    fetchImpl: async () => {
      throw new Error("should-not-fetch");
    },
  });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} })}\n`);
  input.end();
  await done;
  const printed = chunks.join("");
  assert.match(printed, /"unauthorized"/);
  assert.ok(!printed.includes("should-not-fetch"));
  assert.ok(!printed.includes("OpenClaw Studio"));
});
