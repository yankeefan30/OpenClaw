import http from "node:http";
import { DEFAULT_BIND_HOST, LOOPBACK_HOSTS } from "../RicoIMessageMCP/constants.mjs";
import { extractBearer, isAllowedHostHeader } from "../RicoIMessageMCP/http-server.mjs";
import { tokensMatch } from "../RicoIMessageMCP/secrets.mjs";
import { authorizeWorkflowTool } from "./allowlist.mjs";
import { BRIDGE_PATH, MAX_BODY_BYTES, SERVER_NAME, SERVER_VERSION } from "./constants.mjs";
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

export function createBridgeHttpServer({
  runtime,
  allowlist,
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
