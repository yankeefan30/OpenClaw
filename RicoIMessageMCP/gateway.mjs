import { DEFAULT_GATEWAY_URL, LOOPBACK_HOSTS } from "./constants.mjs";
import { fail } from "./errors.mjs";

const CONNECT_SCOPES = Object.freeze(["operator.read", "operator.write"]);
const CONNECT_CLIENT = Object.freeze({
  id: "gateway-client",
  displayName: "rico-imessage-mcp",
  version: "0.4.1",
  platform: "macos",
  mode: "backend",
});

export function buildConnectParams({ token }) {
  return {
    minProtocol: 4,
    maxProtocol: 4,
    client: { ...CONNECT_CLIENT },
    role: "operator",
    scopes: [...CONNECT_SCOPES],
    auth: { token },
  };
}

export function assertLoopbackGatewayUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw fail("gateway_unavailable", "Gateway URL is invalid.");
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw fail("gateway_unavailable", "Gateway URL must be a loopback WebSocket.");
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw fail("gateway_unavailable", "The bridge only connects to a loopback Gateway.");
  }
  return parsed;
}

export function extractIMessageProbe(payload) {
  const defaults = payload?.channelDefaultAccountId;
  const defaultId = typeof defaults?.imessage === "string" ? defaults.imessage.trim() : "";
  const accounts = payload?.channelAccounts?.imessage;
  if (!defaultId || !Array.isArray(accounts)) return { ok: false };
  const matches = accounts.filter((account) => account && typeof account === "object" && String(account.accountId ?? "").trim() === defaultId);
  if (matches.length !== 1) return { ok: false };
  const account = matches[0];
  const probe = account.probe;
  return {
    ok: account.enabled === true
      && account.configured === true
      && account.running === true
      && probe
      && typeof probe === "object"
      && probe.ok === true,
  };
}

export class GatewayClient {
  constructor({
    url = DEFAULT_GATEWAY_URL,
    token,
    webSocket = globalThis.WebSocket,
    now = () => Date.now(),
  } = {}) {
    this.url = url;
    this.token = token;
    this.WebSocket = webSocket;
    this.now = now;
  }

  async health() {
    const payload = await this.call("health", {}, 15_000);
    return { ok: true, version: payload?.server?.version };
  }

  async imessageStatus({ probe = true } = {}) {
    const payload = await this.call("channels.status", {
      probe: probe === true,
      channel: "imessage",
      timeoutMs: 20_000,
    }, 25_000);
    return extractIMessageProbe(payload);
  }

  async sendIMessage({ to, message, idempotencyKey }) {
    const params = { to, message, channel: "imessage" };
    if (idempotencyKey) params.idempotencyKey = idempotencyKey;
    const payload = await this.call("send", params, 45_000);
    const messageId = typeof payload?.messageId === "string" ? payload.messageId.trim() : "";
    if (payload?.channel !== "imessage" || !messageId) {
      throw fail("send_failed", "Gateway did not confirm an iMessage send.");
    }
    return { ok: true, channel: "imessage", messageId };
  }

  async call(method, params = {}, timeoutMs = 15_000) {
    assertLoopbackGatewayUrl(this.url);
    if (typeof this.token !== "string" || !this.token) {
      throw fail("gateway_auth_unavailable", "Gateway authentication is unavailable.");
    }
    if (typeof this.WebSocket !== "function") {
      throw fail("gateway_unavailable", "WebSocket support is unavailable.");
    }

    const deadline = this.now() + timeoutMs;
    const session = openGatewaySession(this.WebSocket, this.url, deadline);
    try {
      await session.opened;
      await session.next((frame) => frame?.event === "connect.challenge");
      const connectId = cryptoRandomId();
      sendJson(session.socket, {
        type: "req",
        id: connectId,
        method: "connect",
        params: buildConnectParams({ token: this.token }),
      });
      const hello = await session.next((frame) => frame?.type === "res" && frame?.id === connectId);
      if (hello?.ok === false) throw fail("gateway_auth_unavailable", "Gateway authentication was rejected.");

      const requestId = cryptoRandomId();
      sendJson(session.socket, { type: "req", id: requestId, method, params });
      const response = await session.next((frame) => frame?.id === requestId);
      if (response?.ok === false) {
        throw fail(method === "send" ? "send_failed" : "gateway_unavailable", "Gateway request was rejected.");
      }
      const payload = response?.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw fail("gateway_unavailable", "Gateway returned an invalid response.");
      }
      return payload;
    } finally {
      session.close();
    }
  }
}

function sendJson(socket, object) {
  socket.send(JSON.stringify(object));
}

function cryptoRandomId() {
  return globalThis.crypto.randomUUID();
}

function openGatewaySession(WebSocketImpl, url, deadline) {
  const socket = new WebSocketImpl(url);
  const queue = [];
  const waiters = [];
  let openedResolve;
  let openedReject;
  const opened = new Promise((resolve, reject) => {
    openedResolve = resolve;
    openedReject = reject;
  });
  const failClosed = (message) => {
    const error = fail("gateway_unavailable", message, { retryable: true });
    openedReject(error);
    while (waiters.length) waiters.shift()?.reject(error);
    return error;
  };
  const timer = setTimeout(() => failClosed("Gateway timed out."), Math.max(1, deadline - Date.now()));

  socket.addEventListener("open", () => openedResolve(), { once: true });
  socket.addEventListener("error", () => failClosed("Gateway connection failed."), { once: true });
  socket.addEventListener("message", (event) => {
    let frame;
    try {
      frame = JSON.parse(String(event.data ?? ""));
    } catch {
      return;
    }
    queue.push(frame);
    for (let index = 0; index < waiters.length; ) {
      const waiter = waiters[index];
      const match = queue.findIndex(waiter.predicate);
      if (match < 0) {
        index += 1;
        continue;
      }
      waiters.splice(index, 1);
      waiter.resolve(queue.splice(match, 1)[0]);
    }
  });

  return {
    socket,
    opened,
    next(predicate) {
      const existing = queue.findIndex(predicate);
      if (existing >= 0) return Promise.resolve(queue.splice(existing, 1)[0]);
      return new Promise((resolve, reject) => waiters.push({ predicate, resolve, reject }));
    },
    close() {
      clearTimeout(timer);
      try { socket.close(); } catch { /* ignore */ }
    },
  };
}
