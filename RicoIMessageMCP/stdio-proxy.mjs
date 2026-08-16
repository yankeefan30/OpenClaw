import readline from "node:readline";
import { DEFAULT_BIND_HOST, DEFAULT_PORT } from "./constants.mjs";
import { fail } from "./errors.mjs";
import { readBearerToken } from "./secrets.mjs";

const MAX_LINE_BYTES = 1024 * 1024;
export const DEFAULT_LOOPBACK_MCP_URL = `http://${DEFAULT_BIND_HOST}:${DEFAULT_PORT}/mcp`;

export function loopbackMcpUrlFromEnv(env = process.env) {
  const raw = env.RICO_IMESSAGE_MCP_URL;
  if (raw == null || raw === "") return DEFAULT_LOOPBACK_MCP_URL;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw fail("bind_refused", "RICO_IMESSAGE_MCP_URL is not a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw fail("bind_refused", "RICO_IMESSAGE_MCP_URL must be http(s).");
  }
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw fail("bind_refused", "Stdio proxy stays on loopback.");
  }
  return parsed.toString();
}

export async function proxyStdioToLoopbackHttp({
  input = process.stdin,
  output = process.stdout,
  url = loopbackMcpUrlFromEnv(),
  tokenPath,
  readToken = () => readBearerToken(tokenPath),
  fetchImpl = fetch,
} = {}) {
  let sessionId;
  const lines = readline.createInterface({ input, crlfDelay: Infinity, terminal: false });
  for await (const line of lines) {
    let response;
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      response = rpcError(null, -32700, "Message too large");
    } else {
      try {
        const message = JSON.parse(line);
        if (Array.isArray(message)) {
          response = rpcError(null, -32600, "JSON-RPC batches are not supported");
        } else {
          const forwarded = await forward(fetchImpl, url, readToken, sessionId, message);
          sessionId = forwarded.sessionId ?? sessionId;
          response = forwarded.rpc;
        }
      } catch (error) {
        response = publicProxyError(error);
      }
    }
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}

async function forward(fetchImpl, url, readToken, sessionId, message) {
  const headers = {
    Authorization: `Bearer ${readToken()}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const response = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
  });
  const nextSession = response.headers.get("mcp-session-id") ?? response.headers.get("Mcp-Session-Id");
  if (response.status === 202) return { sessionId: nextSession, rpc: null };
  if (response.status === 401) return { sessionId: nextSession, rpc: rpcError(message?.id ?? null, -32001, "unauthorized") };
  if (!response.ok) return { sessionId: nextSession, rpc: rpcError(message?.id ?? null, -32002, "upstream_unavailable") };
  const rpc = await response.json();
  return { sessionId: nextSession, rpc };
}

function publicProxyError(error) {
  const code = error?.code;
  if (code === "unauthorized" || code === "secret_store_unavailable") {
    return rpcError(null, -32001, "unauthorized");
  }
  if (code === "bind_refused") return rpcError(null, -32002, "loopback_only");
  return rpcError(null, -32700, "Parse error");
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
