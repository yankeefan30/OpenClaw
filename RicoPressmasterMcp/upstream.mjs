import {
  MCP_PROTOCOL_VERSION,
  PRESSMASTER_RESOURCE,
  SERVER_NAME,
  SERVER_VERSION,
  TOKEN_REFRESH_SKEW_MS,
} from "./constants.mjs";
import { isAccessTokenFresh } from "./credentials.mjs";
import { fail } from "./errors.mjs";
import { refreshAccessToken } from "./oauth.mjs";

export class PressmasterUpstream {
  constructor({
    tokenSource,
    fetchImpl = fetch,
    resource = PRESSMASTER_RESOURCE,
    now = () => new Date(),
  } = {}) {
    this.tokenSource = tokenSource;
    this.fetchImpl = fetchImpl;
    this.resource = resource;
    this.now = now;
    this.sessionId = undefined;
    this.officialTools = null;
  }

  async rpc(message, { retryOnUnauthorized = true } = {}) {
    const bundle = await this.tokenSource.getFreshBundle({ now: this.now() });
    const response = await this.fetchImpl(this.resource, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bundle.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      },
      body: JSON.stringify(message),
    });
    const nextSession = response.headers.get("mcp-session-id") ?? response.headers.get("Mcp-Session-Id");
    if (nextSession) this.sessionId = nextSession;

    if (response.status === 401 && retryOnUnauthorized) {
      await this.tokenSource.refresh({ fetchImpl: this.fetchImpl, now: this.now() });
      return this.rpc(message, { retryOnUnauthorized: false });
    }
    if (response.status === 401) {
      throw fail("pressmaster_unauthorized", "Pressmaster rejected the stored bearer. Re-run --login on original Rico.", { status: 401 });
    }
    if (response.status === 202) return null;
    if (!response.ok) {
      throw fail("upstream_unavailable", "The official Pressmaster MCP did not accept the request.", { status: 502 });
    }
    return parseMcpResponse(response);
  }

  async initialize() {
    const result = await this.rpc({
      jsonrpc: "2.0",
      id: "rico-init",
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    });
    if (result?.error) throw fail("upstream_unavailable", result.error.message || "Pressmaster initialize failed.");
    await this.rpc({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => undefined);
    return result?.result ?? result;
  }

  async listOfficialTools() {
    if (!this.officialTools) {
      const listed = await this.rpc({ jsonrpc: "2.0", id: "rico-tools", method: "tools/list", params: {} });
      if (listed?.error) throw fail("upstream_unavailable", listed.error.message || "Pressmaster tools/list failed.");
      const tools = listed?.result?.tools;
      if (!Array.isArray(tools)) throw fail("upstream_unavailable", "Pressmaster tools/list did not return tools.");
      this.officialTools = tools;
    }
    return this.officialTools;
  }

  async callOfficialTool(name, args) {
    const result = await this.rpc({
      jsonrpc: "2.0",
      id: `rico-call-${name}`,
      method: "tools/call",
      params: { name, arguments: args ?? {} },
    });
    if (result?.error) {
      throw fail("upstream_tool_error", result.error.message || "Pressmaster tool call failed.");
    }
    return result?.result ?? result;
  }
}

export function createTokenSource({
  envBundle,
  keychain,
  refreshFn = refreshAccessToken,
} = {}) {
  let memory = envBundle || null;

  return {
    async getFreshBundle({ now = new Date() } = {}) {
      const bundle = await loadBundle();
      if (isAccessTokenFresh(bundle, now, TOKEN_REFRESH_SKEW_MS)) return bundle;
      return this.refresh({ now });
    },
    async refresh({ fetchImpl = fetch, now = new Date() } = {}) {
      const current = await loadBundle();
      if (!current.refreshToken) {
        throw fail("oauth_refresh_unavailable", "The stored Pressmaster bearer has expired and no refresh token is available. Re-run --login on original Rico.");
      }
      const next = await refreshFn({
        clientId: current.clientId,
        refreshToken: current.refreshToken,
        fetchImpl,
        now,
      });
      memory = next;
      if (keychain?.replaceBundle) await keychain.replaceBundle(next);
      return next;
    },
  };

  async function loadBundle() {
    if (memory) return memory;
    if (keychain?.readBundle) {
      memory = await keychain.readBundle();
      return memory;
    }
    throw fail("pressmaster_auth_missing", "No Pressmaster OAuth bundle is available. On original Rico run: node index.mjs --login");
  }
}

export async function parseMcpResponse(response) {
  const contentType = String(response.headers.get("content-type") ?? "");
  const text = await response.text();
  if (!text) return null;
  if (contentType.includes("text/event-stream") || text.startsWith("event:") || text.includes("\ndata:")) {
    return parseSseJson(text);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw fail("upstream_unavailable", "Pressmaster returned a non-JSON MCP response.");
  }
}

function parseSseJson(text) {
  const blocks = text.split(/\n\n/u);
  for (const block of blocks) {
    const dataLines = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (!dataLines.length) continue;
    const payload = dataLines.join("\n");
    if (!payload || payload === "[DONE]") continue;
    try {
      return JSON.parse(payload);
    } catch {
      // keep scanning
    }
  }
  throw fail("upstream_unavailable", "Pressmaster SSE MCP response did not contain JSON.");
}
