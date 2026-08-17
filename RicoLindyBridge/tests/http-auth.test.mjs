import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedHostHeader } from "../../RicoIMessageMCP/http-server.mjs";
import { assertLoopbackBind } from "../http-server.mjs";
import { TOKEN, authHeaders, mockLocalApps, testRuntime, withServer } from "./helpers.mjs";

test("unauthorized callers are rejected before any local-app call", async () => {
  let listed = 0;
  const runtime = testRuntime(mockLocalApps());
  runtime.localApps.outlookListInbox = async () => {
    listed += 1;
    return { ok: true, client: "outlook", total: 0, truncated: false, messages: [] };
  };

  await withServer(runtime, async (base) => {
    const missing = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflowId: "lindy-cvs-mail-read", tool: "outlook_list_inbox" }),
    });
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).error, "unauthorized");

    const wrong = await fetch(base, {
      method: "POST",
      headers: authHeaders("wrong-token"),
      body: JSON.stringify({ workflowId: "lindy-cvs-mail-read", tool: "outlook_list_inbox" }),
    });
    assert.equal(wrong.status, 401);
    assert.equal(listed, 0);
  });
});

test("bind and Host header stay on loopback or Tailscale MagicDNS", () => {
  assert.equal(assertLoopbackBind("127.0.0.1"), "127.0.0.1");
  assert.throws(() => assertLoopbackBind("0.0.0.0"), { code: "bind_refused" });
  assert.equal(isAllowedHostHeader("127.0.0.1:18792"), true);
  assert.equal(isAllowedHostHeader("rico.tail434bbe.ts.net"), true);
  assert.equal(isAllowedHostHeader("evil.example.com"), false);
});

test("unknown path is not a chat or MCP surface", async () => {
  await withServer(testRuntime(), async (base) => {
    const root = await fetch(new URL("/", base), { headers: authHeaders(TOKEN) });
    assert.equal(root.status, 404);
    const mcp = await fetch(new URL("/mcp", base), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
    });
    assert.equal(mcp.status, 404);
  });
});
