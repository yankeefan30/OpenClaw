import assert from "node:assert/strict";
import test from "node:test";
import { createHttpServer, extractBearer, isMcpPath, isAllowedHostHeader, assertLoopbackBind } from "../http-server.mjs";
import { RicoIMessageMcpServer } from "../mcp-server.mjs";
import { extractIMessageProbe, assertLoopbackGatewayUrl, buildConnectParams } from "../gateway.mjs";

test("bind and gateway URL stay on loopback", () => {
  assert.equal(assertLoopbackBind("127.0.0.1"), "127.0.0.1");
  assert.throws(() => assertLoopbackBind("0.0.0.0"), { code: "bind_refused" });
  assert.throws(() => assertLoopbackBind("192.168.1.10"), { code: "bind_refused" });
  assert.equal(assertLoopbackGatewayUrl("ws://127.0.0.1:18789").hostname, "127.0.0.1");
  assert.throws(() => assertLoopbackGatewayUrl("ws://192.168.1.10:18789"), { code: "gateway_unavailable" });
});

test("MCP paths accept /mcp, /sse, and a Tailscale Serve prefix", () => {
  assert.equal(isMcpPath("/mcp"), true);
  assert.equal(isMcpPath("/rico-imessage-mcp/mcp"), true);
  assert.equal(isMcpPath("/rico-mcp/mcp"), true);
  assert.equal(isMcpPath("/sse"), true);
  assert.equal(isMcpPath("/"), false);
  assert.equal(extractBearer("Bearer abc"), "abc");
  assert.equal(extractBearer("Basic abc"), "");
});

test("Host header allows loopback and Tailscale MagicDNS only", () => {
  assert.equal(isAllowedHostHeader("127.0.0.1:18791"), true);
  assert.equal(isAllowedHostHeader("localhost"), true);
  assert.equal(isAllowedHostHeader("rico.tail434bbe.ts.net"), true);
  assert.equal(isAllowedHostHeader("rico.tail434bbe.ts.net:8444"), true);
  assert.equal(isAllowedHostHeader("evil.example.com"), false);
  assert.equal(isAllowedHostHeader("rico.tail434bbe.ts.net.evil.example"), false);
  assert.equal(isAllowedHostHeader(""), false);
});

test("Gateway connect params use an allowed backend client id", () => {
  const params = buildConnectParams({ token: "unused-in-assertion" });
  assert.equal(params.client.id, "gateway-client");
  assert.equal(params.client.mode, "backend");
  assert.equal(params.client.displayName, "rico-imessage-mcp");
  assert.equal(params.role, "operator");
  assert.deepEqual(params.scopes, ["operator.read", "operator.write"]);
  assert.ok(!Object.prototype.hasOwnProperty.call(params, "commands"));
  assert.ok(!Object.prototype.hasOwnProperty.call(params, "permissions"));
});

test("channels.status probe.ok is extracted without copying account identifiers", () => {
  const ok = extractIMessageProbe({
    channelDefaultAccountId: { imessage: "account-secret" },
    channelAccounts: {
      imessage: [{
        accountId: "account-secret",
        enabled: true,
        configured: true,
        running: true,
        probe: { ok: true },
      }],
    },
  });
  assert.deepEqual(ok, { ok: true });
  assert.ok(!Object.prototype.hasOwnProperty.call(ok, "accountId"));
});

test("HTTP MCP requires a bearer token and stays on loopback", async () => {
  const token = "test-bearer-token";
  const http = createHttpServer({
    mcpServer: new RicoIMessageMcpServer({
      runtime: {
        policy: {
          schemaVersion: 2,
          paused: false,
          identities: [{
            target: "+16469433060",
            kind: "individual",
            access: "owner",
            requireMention: false,
            autoReply: true,
            quietStart: 0,
            quietEnd: 0,
          }],
        },
        gateway: {
          async sendIMessage() { return { messageId: "should-not-run" }; },
          async health() { return { ok: true }; },
          async imessageStatus() { return { ok: true }; },
        },
      },
    }),
    token,
    host: "127.0.0.1",
    port: 0,
  });
  const address = await http.listen();
  const base = `http://127.0.0.1:${address.port}/mcp`;
  try {
    const missing = await fetch(base, { method: "POST", body: "{}" });
    assert.equal(missing.status, 401);

    const wrong = await fetch(base, {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(wrong.status, 401);

    const init = await fetch(base, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
    });
    assert.equal(init.status, 200);
    assert.ok(init.headers.get("mcp-session-id"));
    const initialized = await init.json();
    assert.equal(initialized.result.serverInfo.name, "rico-imessage-mcp");

    const serveHost = await fetch(base, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        Host: "rico.tail434bbe.ts.net:8444",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping", params: {} }),
    });
    assert.equal(serveHost.status, 200);

    const denied = await fetch(base, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "rico_imessage_send", arguments: { to: "+15550000111", text: "nope" } },
      }),
    });
    const body = await denied.json();
    assert.equal(body.result.isError, true);
    assert.equal(body.result.structuredContent.error, "recipient_not_allowlisted");
  } finally {
    await http.close();
  }
});
