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
    "rico_mail_list_accounts",
    "rico_mail_list_inbox",
    "rico_mail_get",
    "rico_mail_send",
    "rico_calendar_list_calendars",
    "rico_calendar_list",
    "rico_calendar_export_notion",
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
    version: "0.4.1",
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
    version: "0.4.1",
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

test("initialize accepts extra Notion client fields and older protocol versions", async () => {
  const mcp = server({ policy: policy(), gateway: { sendIMessage: async () => ({ messageId: "x" }) } });
  const init = await mcp.handle({
    jsonrpc: "2.0",
    id: 9,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: { roots: { listChanged: true } },
      clientInfo: { name: "notion-custom-agent", version: "1.0.0", extras: { workspace: "ignored" } },
      _meta: { "notion/agent": "custom" },
    },
  });
  assert.equal(init.result.protocolVersion, "2024-11-05");
  assert.equal(init.result.serverInfo.name, "rico-imessage-mcp");
});

test("Notion profile lists only CVS Health Mail and iCal tools", async () => {
  const mcp = new RicoIMessageMcpServer({
    runtime: { policy: policy(), gateway: { sendIMessage: async () => ({ messageId: "nope" }) } },
    profile: "notion-cvs",
  });
  const init = await mcp.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", clientInfo: { name: "notion" } },
  });
  assert.equal(init.result.serverInfo.name, "rico-notion-mcp");
  const list = await mcp.handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.deepEqual(list.result.tools.map((tool) => tool.name), [
    "rico_local_apps_health",
    "rico_mail_list_accounts",
    "rico_mail_list_inbox",
    "rico_mail_get",
    "rico_calendar_list_calendars",
    "rico_calendar_list",
    "rico_calendar_export_notion",
    "rico_calendar_upsert",
  ]);
  const denied = await mcp.handle({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "rico_imessage_send", arguments: { to: "+16469433060", text: "nope" } },
  });
  assert.equal(denied.result.isError, true);
  assert.equal(denied.result.structuredContent.error, "tool_not_found");
});

