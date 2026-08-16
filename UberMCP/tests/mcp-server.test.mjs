import assert from "node:assert/strict";
import test from "node:test";
import { StrictMcpServer } from "../mcp-server.mjs";

const runtime = { status: async () => ({ ok: true, enabled: false }) };

test("strict MCP enforces initialization and protocol errors", async () => {
  const server = new StrictMcpServer({ runtime });
  const early = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  assert.equal(early.error.code, -32002);
  const invalid = await server.handle({ jsonrpc: "1.0", id: 2, method: "ping" });
  assert.equal(invalid.error.code, -32600);
  const initialized = await server.handle({ jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  assert.equal(initialized.result.protocolVersion, "2025-03-26");
  const missing = await server.handle({ jsonrpc: "2.0", id: 4, method: "unknown", params: {} });
  assert.equal(missing.error.code, -32601);
});

test("tools/list excludes scheduler/outbox internals and marks proof internal", async () => {
  const server = new StrictMcpServer({ runtime });
  await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  const listed = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.equal(listed.result.tools.some((tool) => /monitor|outbox|acknowledge/iu.test(tool.name)), false);
  const protectedTools = listed.result.tools.filter((tool) => tool.name !== "uber_status");
  assert.equal(protectedTools.every((tool) => tool.inputSchema.properties.invocation_proof["x-openclaw-internal"] === true), true);
});

test("status rejects unexpected arguments as a tool error", async () => {
  const server = new StrictMcpServer({ runtime });
  await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  const response = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "uber_status", arguments: { surprise: true } } });
  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.error, "tool_arguments_invalid");
});
