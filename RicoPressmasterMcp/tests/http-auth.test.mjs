import assert from "node:assert/strict";
import test from "node:test";
import { assertLoopbackBind, createHttpServer, isAllowedHostHeader, isMcpPath } from "../http-server.mjs";
import { RicoPressmasterMcpServer } from "../mcp-server.mjs";

test("HTTP bind stays on loopback", () => {
  assert.equal(assertLoopbackBind("127.0.0.1"), "127.0.0.1");
  assert.throws(() => assertLoopbackBind("0.0.0.0"), { code: "bind_refused" });
  assert.throws(() => assertLoopbackBind("192.168.1.10"), { code: "bind_refused" });
  assert.equal(isMcpPath("/mcp"), true);
  assert.equal(isMcpPath("/"), false);
  assert.equal(isAllowedHostHeader("127.0.0.1:18793"), true);
  assert.equal(isAllowedHostHeader("localhost"), true);
  assert.equal(isAllowedHostHeader("rico.tail434bbe.ts.net"), false);
  assert.equal(isAllowedHostHeader("evil.example.com"), false);
});

test("loopback HTTP initialize works and foreign hosts are 403", async () => {
  const http = createHttpServer({
    mcpServer: new RicoPressmasterMcpServer({ runtime: { authStatus: { available: false, source: "none" } } }),
    host: "127.0.0.1",
    port: 0,
  });
  const address = await http.listen();
  const init = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Host: "127.0.0.1" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    }),
  });
  assert.equal(init.status, 200);
  const body = await init.json();
  assert.equal(body.result.serverInfo.name, "rico-pressmaster-mcp");

  const blocked = await new Promise((resolve, reject) => {
    import("node:http").then(({ default: nodeHttp }) => {
      const request = nodeHttp.request({
        host: "127.0.0.1",
        port: address.port,
        path: "/mcp",
        method: "POST",
        headers: { Host: "evil.example.com", "Content-Type": "application/json" },
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      });
      request.on("error", reject);
      request.end(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }));
    });
  });
  assert.equal(blocked.status, 403);
  await http.close();
});
