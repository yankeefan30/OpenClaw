import assert from "node:assert/strict";
import test from "node:test";
import { createTokenSource, parseMcpResponse, PressmasterUpstream } from "../upstream.mjs";

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    async text() { return JSON.stringify(body); },
  };
}

test("upstream sends the bearer to the official MCP and parses SSE", async () => {
  const calls = [];
  const upstream = new PressmasterUpstream({
    tokenSource: {
      async getFreshBundle() {
        return { accessToken: "access-token-value-1234", refreshToken: "", clientId: "c1" };
      },
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, authorization: init.headers.Authorization, body: init.body });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream", "mcp-session-id": "sess-1" }),
        async text() {
          return "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":\"rico-init\",\"result\":{\"serverInfo\":{\"name\":\"pressmaster\"}}}\n\n";
        },
      };
    },
  });
  const result = await upstream.initialize();
  assert.equal(calls[0].url, "https://app.pressmaster.ai/mcp");
  assert.equal(calls[0].authorization, "Bearer access-token-value-1234");
  assert.equal(result.serverInfo.name, "pressmaster");
  assert.equal(upstream.sessionId, "sess-1");
});

test("401 refreshes once and retries; tokens are not placed in thrown errors", async () => {
  const statuses = [401, 200];
  let refreshed = 0;
  const upstream = new PressmasterUpstream({
    tokenSource: {
      async getFreshBundle() {
        return { accessToken: refreshed ? "new-access-token-value" : "old-access-token-value", refreshToken: "refresh-token-value-1234", clientId: "c1" };
      },
      async refresh() {
        refreshed += 1;
        return { accessToken: "new-access-token-value" };
      },
    },
    fetchImpl: async () => jsonResponse({ jsonrpc: "2.0", id: 1, result: { tools: [] } }, { status: statuses.shift() }),
  });
  const listed = await upstream.listOfficialTools();
  assert.deepEqual(listed, []);
  assert.equal(refreshed, 1);
});

test("parseMcpResponse reads JSON or SSE", async () => {
  const json = await parseMcpResponse(jsonResponse({ ok: true }));
  assert.deepEqual(json, { ok: true });
  const sse = await parseMcpResponse({
    headers: new Headers({ "content-type": "text/event-stream" }),
    async text() { return "data: {\"ok\":true}\n\n"; },
  });
  assert.deepEqual(sse, { ok: true });
});

test("token source fails closed without a bundle", async () => {
  const source = createTokenSource({});
  await assert.rejects(() => source.getFreshBundle(), { code: "pressmaster_auth_missing" });
});
