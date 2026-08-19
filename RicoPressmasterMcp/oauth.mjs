import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import {
  DEFAULT_BIND_HOST,
  LOOPBACK_HOSTS,
  PRESSMASTER_AUTHORIZATION_ENDPOINT,
  PRESSMASTER_ISSUER,
  PRESSMASTER_REGISTRATION_ENDPOINT,
  PRESSMASTER_RESOURCE,
  PRESSMASTER_SCOPES,
  PRESSMASTER_TOKEN_ENDPOINT,
} from "./constants.mjs";
import { bundleFromOAuthTokenResponse } from "./credentials.mjs";
import { fail } from "./errors.mjs";

export function createPkcePair(randomBytes = crypto.randomBytes) {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthorizeUrl({
  clientId,
  redirectUri,
  state,
  challenge,
  scope = PRESSMASTER_SCOPES,
  resource = PRESSMASTER_RESOURCE,
}) {
  const url = new URL(PRESSMASTER_AUTHORIZATION_ENDPOINT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", resource);
  return url.toString();
}

export async function registerPublicClient({
  redirectUri,
  clientName = "Rico Pressmaster MCP",
  fetchImpl = fetch,
} = {}) {
  assertLoopbackRedirect(redirectUri);
  const response = await fetchImpl(PRESSMASTER_REGISTRATION_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: PRESSMASTER_SCOPES,
    }),
  });
  const body = await readJson(response);
  if (!response.ok || typeof body.client_id !== "string" || !body.client_id) {
    throw fail("oauth_register_failed", "Pressmaster dynamic client registration failed.", { status: 502 });
  }
  if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== "none") {
    throw fail("oauth_register_failed", "Pressmaster registered a confidential client; Rico only stores public PKCE clients.");
  }
  return {
    clientId: body.client_id,
    tokenEndpointAuthMethod: "none",
    issuer: PRESSMASTER_ISSUER,
  };
}

export async function exchangeAuthorizationCode({
  clientId,
  code,
  redirectUri,
  verifier,
  fetchImpl = fetch,
  now = new Date(),
}) {
  assertLoopbackRedirect(redirectUri);
  const body = await postToken(fetchImpl, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
    resource: PRESSMASTER_RESOURCE,
  });
  return tokenResponseToBundle(body, clientId, now);
}

export async function refreshAccessToken({
  clientId,
  refreshToken,
  fetchImpl = fetch,
  now = new Date(),
}) {
  if (typeof refreshToken !== "string" || refreshToken.length < 8) {
    throw fail("oauth_refresh_unavailable", "No Pressmaster refresh token is stored. Run --login on original Rico.");
  }
  const body = await postToken(fetchImpl, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    resource: PRESSMASTER_RESOURCE,
  });
  return tokenResponseToBundle(body, clientId, now, refreshToken);
}

export function listenForAuthorizationCode({
  host = DEFAULT_BIND_HOST,
  port = 0,
  expectedState,
  timeoutMs = 5 * 60_000,
  createServer = http.createServer,
} = {}) {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw fail("bind_refused", "The OAuth callback binds loopback only.");
  }

  let settle;
  const done = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });

  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${host}`);
      if (url.pathname !== "/oauth/callback") {
        response.writeHead(404, { "Content-Type": "text/plain" });
        response.end("Not found");
        return;
      }
      const error = url.searchParams.get("error");
      if (error) {
        response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<html><body>Pressmaster denied the login. You can close this window.</body></html>");
        finish(fail("oauth_denied", `Pressmaster authorization failed: ${error}.`));
        return;
      }
      const state = url.searchParams.get("state") ?? "";
      const code = url.searchParams.get("code") ?? "";
      if (!code || state !== expectedState) {
        response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<html><body>Invalid OAuth callback. You can close this window.</body></html>");
        finish(fail("oauth_callback_invalid", "The Pressmaster OAuth callback state or code was invalid."));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<html><body>Rico stored the Pressmaster login in macOS Keychain. You can close this window.</body></html>");
      finish(null, { code, state });
    } catch (error) {
      finish(error);
    }
  });

  const timer = setTimeout(() => {
    finish(fail("oauth_timeout", "Pressmaster login timed out. Re-run --login on original Rico."));
  }, timeoutMs);
  timer.unref?.();

  let settled = false;
  function finish(error, value) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    server.closeAllConnections?.();
    server.close(() => {
      if (error) settle.reject(error);
      else settle.resolve(value);
    });
  }

  server.on("connection", (socket) => {
    const address = socket.remoteAddress;
    const normalized = address?.startsWith("::ffff:") ? address.slice(7) : address;
    if (address && !LOOPBACK_HOSTS.has(normalized)) socket.destroy();
  });

  const listening = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve(server.address());
    });
  });

  return { server, listening, done };
}

export async function runLogin({
  fetchImpl = fetch,
  openUrl = openMacUrl,
  writeBundle,
  now = new Date(),
  listen = listenForAuthorizationCode,
  stdout = process.stdout,
} = {}) {
  const state = base64url(crypto.randomBytes(16));
  const pkce = createPkcePair();
  const listener = listen({ expectedState: state });
  const address = await listener.listening;
  const redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;
  const client = await registerPublicClient({ redirectUri, fetchImpl });
  const authorizeUrl = buildAuthorizeUrl({
    clientId: client.clientId,
    redirectUri,
    state,
    challenge: pkce.challenge,
  });
  stdout.write("Open this Pressmaster URL on original Rico and sign in as Alan:\n");
  stdout.write(`${authorizeUrl}\n`);
  await openUrl(authorizeUrl);
  const { code } = await listener.done;
  const bundle = await exchangeAuthorizationCode({
    clientId: client.clientId,
    code,
    redirectUri,
    verifier: pkce.verifier,
    fetchImpl,
    now,
  });
  await writeBundle(bundle);
  stdout.write("Pressmaster OAuth bundle written to macOS Keychain (service rico-pressmaster-mcp, account alan).\n");
  stdout.write("Token values were not printed.\n");
  return { ok: true, stored: true, source: "keychain" };
}

export function openMacUrl(url) {
  return new Promise((resolve) => {
    if (process.platform !== "darwin") {
      resolve(false);
      return;
    }
    const child = spawn("/usr/bin/open", [url], { stdio: "ignore" });
    child.once("exit", () => resolve(true));
    child.once("error", () => resolve(false));
  });
}

function tokenResponseToBundle(body, clientId, now, previousRefresh = "") {
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw fail("oauth_token_invalid", "Pressmaster did not return an access token.");
  }
  return bundleFromOAuthTokenResponse({
    clientId,
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : previousRefresh,
    tokenType: body.token_type || "Bearer",
    scope: body.scope,
    expiresIn: body.expires_in,
    now,
  });
}

async function postToken(fetchImpl, params) {
  const response = await fetchImpl(PRESSMASTER_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(params).toString(),
  });
  const body = await readJson(response);
  if (!response.ok) {
    const error = body.error || "invalid_token";
    throw fail("oauth_token_failed", `Pressmaster token endpoint refused the grant (${error}).`, { status: 401 });
  }
  return body;
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw fail("oauth_token_invalid", "Pressmaster returned a non-JSON OAuth response.");
  }
}

function assertLoopbackRedirect(redirectUri) {
  let parsed;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw fail("bind_refused", "OAuth redirect_uri must be loopback HTTP.");
  }
  if (parsed.protocol !== "http:" || !LOOPBACK_HOSTS.has(parsed.hostname) || parsed.pathname !== "/oauth/callback") {
    throw fail("bind_refused", "OAuth redirect_uri must be http://127.0.0.1:<port>/oauth/callback.");
  }
}

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}
