import http from "node:http";
import { DEFAULT_BIND_HOST, LOOPBACK_HOSTS } from "../RicoIMessageMCP/constants.mjs";
import { extractBearer, isAllowedHostHeader } from "../RicoIMessageMCP/http-server.mjs";
import { tokensMatch } from "../RicoIMessageMCP/secrets.mjs";
import { randomUUID } from "node:crypto";
import { authorizeWorkflowTool } from "./allowlist.mjs";
import { BRIDGE_PATH, MAX_BODY_BYTES, MCP_PATH, SERVER_NAME, SERVER_VERSION } from "./constants.mjs";
import { BridgeError, fail, publicError } from "./errors.mjs";
import { TOOL_CATALOG, callBridgeTool } from "./tools.mjs";

export function assertLoopbackBind(host) {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw fail("bind_refused", "The Lindy local bridge binds loopback only.");
  }
  return host;
}

export function isBridgePath(pathname) {
  return pathname === BRIDGE_PATH;
}

export function isLindyMcpPath(pathname) {
  return pathname === MCP_PATH
    || pathname.endsWith("/lindy/mcp")
    || pathname === "/mcp"
    || pathname.endsWith("/mcp")
    || pathname === "/sse"
    || pathname.endsWith("/sse")
    || pathname === "/lindy/sse"
    || pathname.endsWith("/lindy/sse");
}

export function createBridgeHttpServer({
  runtime,
  allowlist,
  mcpServer,
  token,
  host = DEFAULT_BIND_HOST,
  port,
}) {
  assertLoopbackBind(host);
  if (typeof token !== "string" || !token) {
    throw fail("secret_store_unavailable", "Bearer token is unavailable.");
  }
  if (!allowlist) {
    throw fail("allowlist_unavailable", "Lindy workflow allowlist is unavailable.");
  }

  const sessions = new Set();
  const server = http.createServer(async (request, response) => {
    try {
      if (!isAllowedHostHeader(request.headers.host)) {
        sendJson(response, 403, { ok: false, error: "loopback_only" });
        return;
      }
      if (!tokensMatch(token, extractBearer(request.headers.authorization))) {
        response.setHeader("WWW-Authenticate", "Bearer");
        sendJson(response, 401, { ok: false, error: "unauthorized" });
        return;
      }

      const url = new URL(request.url ?? "/", `http://${host}`);
      if (isLindyMcpPath(url.pathname)) {
        await handleMcp({ request, response, mcpServer, sessions });
        return;
      }
      if (!isBridgePath(url.pathname)) {
        sendJson(response, 404, { ok: false, error: "not_found" });
        return;
      }

      if (request.method === "GET") {
        sendJson(response, 200, {
          ok: true,
          bridge: SERVER_NAME,
          version: SERVER_VERSION,
          speaker: "lindy",
          imessage: "disabled",
          tools: TOOL_CATALOG,
        });
        return;
      }

      if (request.method !== "POST") {
        sendJson(response, 405, { ok: false, error: "method_not_allowed" });
        return;
      }

      const body = await readBody(request);
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        sendJson(response, 400, { ok: false, error: "invalid_json", message: "Request body must be JSON." });
        return;
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        sendJson(response, 400, { ok: false, error: "invalid_request", message: "Request body must be a JSON object." });
        return;
      }
      if (payload.prompt || payload.messages || payload.session || payload.chat) {
        sendJson(response, 403, {
          ok: false,
          error: "tool_not_allowed",
          message: "This bridge is not a general Rico chat turn.",
        });
        return;
      }

      const authorized = authorizeWorkflowTool({
        allowlist,
        workflowId: payload.workflowId,
        tool: payload.tool,
      });
      const result = await callBridgeTool(runtime, authorized.tool, payload.arguments ?? {});
      sendJson(response, 200, {
        ok: true,
        workflowId: authorized.workflowId,
        tool: authorized.tool,
        result,
      });
    } catch (error) {
      const status = error instanceof BridgeError ? error.status : 500;
      sendJson(response, status, publicError(error));
    }
  });

  server.on("connection", (socket) => {
    const address = socket.remoteAddress;
    if (address && !LOOPBACK_HOSTS.has(normalizeRemoteAddress(address))) {
      socket.destroy();
    }
  });

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          resolve(server.address());
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function handleMcp({ request, response, mcpServer, sessions }) {
  if (!mcpServer) {
    sendJson(response, 503, { ok: false, error: "mcp_unavailable" });
    return;
  }
  if (request.method === "DELETE") {
    const session = request.headers["mcp-session-id"];
    if (typeof session === "string") sessions.delete(session);
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method === "GET") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    response.write(": connected\n\n");
    return;
  }
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "method_not_allowed" });
    return;
  }

  const body = await readBody(request);
  let message;
  try {
    message = JSON.parse(body);
  } catch {
    sendJson(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  if (Array.isArray(message)) {
    sendJson(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "JSON-RPC batches are not supported" } });
    return;
  }

  const rpc = await mcpServer.handle(message);
  if (message?.method === "initialize" && rpc?.result) {
    const sessionId = randomUUID();
    sessions.add(sessionId);
    response.setHeader("Mcp-Session-Id", sessionId);
  }
  if (!rpc) {
    response.writeHead(202);
    response.end();
    return;
  }

  const accept = String(request.headers.accept ?? "");
  if (accept.includes("text/event-stream") && !accept.includes("application/json")) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    response.end(`event: message\ndata: ${JSON.stringify(rpc)}\n\n`);
    return;
  }
  sendJson(response, 200, rpc);
}

function normalizeRemoteAddress(address) {
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  response.end(payload);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        reject(fail("payload_too_large", "Request is too large."));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}
