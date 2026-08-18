import assert from "node:assert/strict";
import test from "node:test";
import { FORBIDDEN_TOOLS } from "../constants.mjs";
import { MCP_TOOL_DEFINITIONS } from "../mcp-tools.mjs";
import { RicoLindyMcpServer, resolveWorkflowId } from "../mcp-server.mjs";
import { authHeaders, exampleAllowlist, mockLocalApps, testRuntime, withServer } from "./helpers.mjs";

async function initialized(mcp) {
  const init = await mcp.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "lindy-test", version: "1" } },
  });
  assert.equal(init.result.serverInfo.name, "rico-lindy-bridge");
  assert.equal(init.result.instructions.includes("iMessage"), true);
  assert.equal(init.result.instructions.includes("not the OpenClaw Gateway"), true);
  return mcp;
}

test("MCP lists only mail/calendar tools and defaults to the lindy-mcp workflow", async () => {
  const mcp = await initialized(new RicoLindyMcpServer({
    runtime: testRuntime(),
    allowlist: exampleAllowlist(),
  }));
  const list = await mcp.handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const names = list.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    "health",
    "outlook_list_inbox",
    "outlook_search",
    "outlook_get",
    "outlook_draft",
    "calendar_names",
    "mailbox_names",
    "calendar_list",
    "calendar_upsert",
  ]);
  assert.equal(names.some((name) => FORBIDDEN_TOOLS.includes(name)), false);
  assert.equal(MCP_TOOL_DEFINITIONS.some((tool) => /imessage|mail_send|outlook_send|teams|slack/i.test(tool.name)), false);
  assert.equal(resolveWorkflowId({ arguments: {} }), "lindy-mcp");
  assert.equal(resolveWorkflowId({ arguments: { workflowId: "lindy-cvs-mail-read" } }), "lindy-cvs-mail-read");
});

test("streamable HTTP MCP requires bearer and executes an approved Outlook read", async () => {
  const runtime = testRuntime();
  await withServer(runtime, async (_rest, mcpUrl) => {
    const missing = await fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(missing.status, 401);

    const init = await fetch(mcpUrl, {
      method: "POST",
      headers: { ...authHeaders(), Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
    });
    assert.equal(init.status, 200);
    assert.ok(init.headers.get("mcp-session-id"));

    const call = await fetch(mcpUrl, {
      method: "POST",
      headers: { ...authHeaders(), Accept: "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "outlook_list_inbox", arguments: { limit: 5 } },
      }),
    });
    const body = await call.json();
    assert.equal(call.status, 200);
    assert.equal(body.result.isError, false);
    assert.equal(body.result.structuredContent.client, "outlook");
    assert.equal(body.result.structuredContent.messages[0].subject, "Flight note");
  });
});

test("MCP refuses iMessage, outlook_send, and general chat", async () => {
  const drafts = [];
  const sends = [];
  const mcp = await initialized(new RicoLindyMcpServer({
    runtime: testRuntime(mockLocalApps({ drafts, sends })),
    allowlist: exampleAllowlist(),
  }));
  for (const name of ["rico_imessage_send", "rico_outlook_send", "rico_mail_send", "ask", "chat"]) {
    const denied = await mcp.handle({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name, arguments: { to: "nobody@example.com", text: "nope" } },
    });
    assert.equal(denied.result.isError, true);
    assert.equal(denied.result.structuredContent.error, "tool_not_allowed");
  }
  const stranger = await mcp.handle({
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: { name: "outlook_draft", arguments: { to: "stranger@example.com", subject: "Hi", text: "No." } },
  });
  assert.equal(stranger.result.isError, true);
  assert.equal(stranger.result.structuredContent.error, "recipient_not_allowlisted");
  assert.equal(drafts.length, 0);
  assert.equal(sends.length, 0);
});
