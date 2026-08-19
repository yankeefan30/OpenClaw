import assert from "node:assert/strict";
import test from "node:test";
import { RicoPressmasterMcpServer } from "../mcp-server.mjs";
import { LOCAL_TOOL_NAMES } from "../constants.mjs";

function server(runtime) {
  return new RicoPressmasterMcpServer({ runtime });
}

async function init(mcp) {
  return mcp.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
}

test("lists local tools before auth and merges official tools after", async () => {
  const mcp = server({ authStatus: { available: false, source: "none" } });
  const before = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  assert.equal(before.error.code, -32002);
  await init(mcp);
  const list = await mcp.handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.deepEqual(list.result.tools.map((tool) => tool.name), [...LOCAL_TOOL_NAMES]);

  const authed = server({
    authStatus: { available: true, source: "keychain" },
    upstream: {
      async listOfficialTools() {
        return [{ name: "publish_content", description: "Publish or schedule a draft" }];
      },
    },
  });
  await init(authed);
  const merged = await authed.handle({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
  assert.ok(merged.result.tools.some((tool) => tool.name === "rico_pressmaster_health"));
  assert.ok(merged.result.tools.some((tool) => tool.name === "publish_content"));
});

test("create tool result is not a publish and errors stay public", async () => {
  const calls = [];
  const mcp = server({
    authStatus: { available: true, source: "env" },
    upstream: {
      async listOfficialTools() {
        return [{ name: "create_content", description: "Create a draft article" }];
      },
      async callOfficialTool(name, args) {
        calls.push({ name, args });
        return { id: "d1" };
      },
    },
  });
  await init(mcp);
  const created = await mcp.handle({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "rico_pressmaster_create_or_update_draft", arguments: { title: "T", body: "B" } },
  });
  assert.equal(created.result.isError, false);
  assert.equal(created.result.structuredContent.officialTool, "create_content");
  assert.deepEqual(calls, [{ name: "create_content", args: { title: "T", body: "B" } }]);

  const missing = await mcp.handle({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "rico_pressmaster_list_drafts", arguments: {} },
  });
  assert.equal(missing.result.isError, true);
  assert.equal(missing.result.structuredContent.error, "official_tool_missing");
});
