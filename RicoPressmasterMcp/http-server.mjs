import http from "node:http";
import { randomUUID } from "node:crypto";
import { DEFAULT_BIND_HOST, LOOPBACK_HOSTS, MAX_BODY_BYTES } from "./constants.mjs";
import { fail } from "./errors.mjs";

export function assertLoopbackBind(host) {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw fail("bind_refused", "The Rico Pressmaster MCP server binds loopback only.");
  }
  return host;
}

export function isMcpPath(pathname) {
  return pathname === "/mcp" || pathname.endsWith("/mcp");
}

export function isAllowedHostHeader(value) {
  if (typeof value !== "string" || !value) return false;
  const host = value.split(":")[0]?.toLowerCase();
  return LOOPBACK_HOSTS.has(host);
}

export function createHttpServer({
  mcpServer,
  host = DEFAULT_BIND_HOST,
  port,
}) {
  assertLoopbackBind(host);
  const sessions = new Set();
  const server = http.createServer(async (request, response) => {
    try {
      if (!isAllowedHostHeader(request.headers.host)) {
        sendJson(response, 403, { error: "loopback_only" });
        return;
      }

      const url = new URL(request.url ?? "/", `http://${host}`);
      if (!isMcpPath(url.pathname)) {
        sendJson(response, 404, { error: "not_found" });
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
        sendJson(response, 405, { error: "method_not_allowed" });
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
    } catch {
      sendJson(response, 500, { error: "internal_error" });
    }
  });

  server.on("connection", (socket) => {
    const address = socket.remoteAddress;
    const normalized = address?.startsWith("::ffff:") ? address.slice(7) : address;
    if (address && !LOOPBACK_HOSTS.has(normalized)) socket.destroy();
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
      return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
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
