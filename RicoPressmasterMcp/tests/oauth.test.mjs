import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { buildAuthorizeUrl, createPkcePair, exchangeAuthorizationCode, listenForAuthorizationCode, refreshAccessToken, registerPublicClient, runLogin } from "../oauth.mjs";

test("PKCE and authorize URL stay on the official Pressmaster issuer", () => {
  const pkce = createPkcePair(() => Buffer.alloc(32, 7));
  assert.equal(pkce.verifier.length > 20, true);
  const url = new URL(buildAuthorizeUrl({
    clientId: "client-1",
    redirectUri: "http://127.0.0.1:18793/oauth/callback",
    state: "state-1",
    challenge: pkce.challenge,
  }));
  assert.equal(url.origin, "https://app.pressmaster.ai");
  assert.equal(url.pathname, "/oauth/mcp/auth");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("resource"), "https://app.pressmaster.ai/mcp");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:18793/oauth/callback");
});

test("dynamic client registration posts to the official endpoint", async () => {
  const calls = [];
  const client = await registerPublicClient({
    redirectUri: "http://127.0.0.1:18793/oauth/callback",
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 201,
        async text() {
          return JSON.stringify({ client_id: "registered-client-id-1", token_endpoint_auth_method: "none" });
        },
      };
    },
  });
  assert.equal(calls[0].url, "https://app.pressmaster.ai/oauth/mcp/reg");
  assert.equal(calls[0].body.token_endpoint_auth_method, "none");
  assert.deepEqual(calls[0].body.redirect_uris, ["http://127.0.0.1:18793/oauth/callback"]);
  assert.equal(client.clientId, "registered-client-id-1");
});

test("token exchange and refresh pin the official token endpoint", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init.body });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          access_token: "access-token-value-1234",
          refresh_token: "refresh-token-value-1234",
          token_type: "Bearer",
          scope: "openid offline_access mcp",
          expires_in: 3600,
        });
      },
    };
  };
  const exchanged = await exchangeAuthorizationCode({
    clientId: "registered-client-id-1",
    code: "auth-code",
    redirectUri: "http://127.0.0.1:18793/oauth/callback",
    verifier: "verifier-value",
    fetchImpl,
    now: new Date("2026-08-19T13:00:00.000Z"),
  });
  assert.equal(calls[0].url, "https://app.pressmaster.ai/oauth/mcp/token");
  assert.match(calls[0].body, /grant_type=authorization_code/);
  assert.equal(exchanged.accessToken, "access-token-value-1234");
  const refreshed = await refreshAccessToken({
    clientId: "registered-client-id-1",
    refreshToken: "refresh-token-value-1234",
    fetchImpl,
  });
  assert.match(calls[1].body, /grant_type=refresh_token/);
  assert.equal(refreshed.refreshToken, "refresh-token-value-1234");
});

test("OAuth callback accepts only loopback and matching state", async () => {
  const listener = listenForAuthorizationCode({ expectedState: "abc", timeoutMs: 2_000 });
  const address = await listener.listening;
  const ok = await fetch(`http://127.0.0.1:${address.port}/oauth/callback?code=the-code&state=abc`);
  assert.equal(ok.status, 200);
  const result = await listener.done;
  assert.equal(result.code, "the-code");
});

test("runLogin stores a bundle and never prints tokens", async () => {
  const chunks = [];
  const stored = [];
  await runLogin({
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/reg")) {
        return { ok: true, status: 201, async text() { return JSON.stringify({ client_id: "registered-client-id-1", token_endpoint_auth_method: "none" }); } };
      }
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            access_token: "access-token-value-1234",
            refresh_token: "refresh-token-value-1234",
            token_type: "Bearer",
            scope: "mcp",
            expires_in: 3600,
          });
        },
      };
    },
    openUrl: async () => false,
    writeBundle: async (bundle) => { stored.push(bundle); },
    listen: () => ({
      listening: Promise.resolve({ port: 18793 }),
      done: Promise.resolve({ code: "auth-code", state: "x" }),
    }),
    stdout: { write: (chunk) => chunks.push(chunk) },
  });
  const printed = chunks.join("");
  assert.match(printed, /Keychain/);
  assert.ok(!printed.includes("access-token-value-1234"));
  assert.ok(!printed.includes("refresh-token-value-1234"));
  assert.equal(stored[0].accessToken, "access-token-value-1234");
  void http;
});
