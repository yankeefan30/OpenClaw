import assert from "node:assert/strict";
import test from "node:test";
import { RicoIMessageMcpServer } from "../mcp-server.mjs";
import { health } from "../tools.mjs";

function policy() {
  return {
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
  };
}

function server(runtime) {
  return new RicoIMessageMcpServer({ runtime });
}

test("MCP server initializes and lists Rico iMessage plus local-app tools", async () => {
  const mcp = server({ policy: policy(), gateway: { sendIMessage: async () => ({ messageId: "x" }) } });
  const before = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  assert.equal(before.error.code, -32002);
  const init = await mcp.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  const list = await mcp.handle({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
  assert.deepEqual(list.result.tools.map((tool) => tool.name), [
    "rico_imessage_send",
    "rico_imessage_health",
    "rico_imessage_can_send",
    "rico_local_apps_health",
    "rico_mail_list_inbox",
    "rico_mail_get",
    "rico_mail_send",
    "rico_calendar_list",
    "rico_calendar_upsert",
    "rico_outlook_list_inbox",
    "rico_outlook_get",
    "rico_outlook_send",
  ]);
});

test("health reports gateway + probe.ok and never echoes secrets", async () => {
  const secret = "super-secret-gateway-token";
  const result = await health({
    gateway: {
      async health() { return { ok: true, version: "2026.7.1" }; },
      async imessageStatus() { return { ok: true, token: secret, accountId: "should-not-leak" }; },
    },
  });
  assert.deepEqual(result, {
    ok: true,
    gatewayOnline: true,
    imessageProbeOk: true,
    bridge: "rico-imessage-mcp",
    version: "0.3.0",
  });
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!JSON.stringify(result).includes("should-not-leak"));
});

test("health stays fail-closed when the probe is not ok", async () => {
  const result = await health({
    gateway: {
      async health() { return { ok: true }; },
      async imessageStatus() { return { ok: false }; },
    },
  });
  assert.deepEqual(result, {
    ok: false,
    gatewayOnline: true,
    imessageProbeOk: false,
    bridge: "rico-imessage-mcp",
    version: "0.3.0",
  });
});

test("tool errors stay closed without stack traces or secret strings", async () => {
  const mcp = server({
    policy: policy(),
    gateway: {
      async sendIMessage() {
        throw Object.assign(new Error("gateway-token-should-not-leak"), { stack: "secret-stack" });
      },
    },
  });
  await mcp.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  const response = await mcp.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "rico_imessage_send", arguments: { to: "+16469433060", text: "hi" } },
  });
  const serialized = JSON.stringify(response);
  assert.equal(response.result.isError, true);
  assert.ok(!serialized.includes("gateway-token-should-not-leak"));
  assert.ok(!serialized.includes("secret-stack"));
});
