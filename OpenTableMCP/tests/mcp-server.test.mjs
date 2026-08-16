import assert from "node:assert/strict";
import test from "node:test";
import { StrictMcpServer } from "../mcp-server.mjs";

test("strict MCP server initializes, lists governed tools, and returns structured status", async () => {
  const runtime = { status: async () => ({ ok: true, enabled: false, reason: "keychain_missing" }) };
  const server = new StrictMcpServer({ runtime });
  const before = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  assert.equal(before.error.code, -32002);
  const init = await server.handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  const list = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
  const names = list.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    "opentable_status", "opentable_restaurant_search", "opentable_availability_search", "opentable_booking_preview",
    "opentable_booking_hold", "opentable_booking_confirm", "opentable_reservations_list", "opentable_cancel_preview", "opentable_cancel_confirm",
  ]);
  assert.ok(list.result.tools.every((tool) => tool.inputSchema.additionalProperties === false));
  assert.ok(list.result.tools.every((tool) => !tool.inputSchema.required.includes("invocation_proof")));
  for (const tool of list.result.tools.filter((item) => item.inputSchema.properties.invocation_proof)) {
    assert.equal(tool.inputSchema.properties.invocation_proof["x-openclaw-internal"], true);
    assert.equal(tool.inputSchema.properties.invocation_proof.writeOnly, true);
  }
  const status = await server.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "opentable_status", arguments: {} } });
  assert.equal(status.result.isError, false);
  assert.equal(status.result.structuredContent.reason, "keychain_missing");
});

test("MCP server fails tool errors closed without stack traces", async () => {
  const runtime = { status: async () => { throw Object.assign(new Error("secret upstream detail"), { stack: "credential-secret-stack" }); } };
  const server = new StrictMcpServer({ runtime });
  await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  const response = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "opentable_status", arguments: {} } });
  const serialized = JSON.stringify(response);
  assert.equal(response.result.isError, true);
  assert.ok(!serialized.includes("secret upstream detail"));
  assert.ok(!serialized.includes("credential-secret-stack"));
});
