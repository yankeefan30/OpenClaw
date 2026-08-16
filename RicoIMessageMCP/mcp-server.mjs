import { MCP_PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "./constants.mjs";
import { publicError } from "./errors.mjs";
import { callTool, TOOL_DEFINITIONS } from "./tools.mjs";

export class RicoIMessageMcpServer {
  constructor({ runtime } = {}) {
    this.runtime = runtime;
    this.initialized = false;
  }

  async handle(message) {
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return rpcError(message?.id ?? null, -32600, "Invalid Request");
    }
    const notification = message.id === undefined;
    if (message.method === "initialize") {
      if (notification) return null;
      const requested = message.params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : MCP_PROTOCOL_VERSION;
      this.initialized = true;
      return rpcResult(message.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: "Narrow Rico OpenClaw bridge on this Mac. iMessage: rico_imessage_health, rico_imessage_can_send, rico_imessage_send (allowlisted E.164 or chat_id only). Local apps: rico_local_apps_health, rico_mail_* (allowlisted send), rico_calendar_*, rico_outlook_* (governed Outlook recipients only). This is not the OpenClaw Gateway and does not expose arbitrary Gateway methods.",
      });
    }
    if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return null;
    if (message.method === "ping") return notification ? null : rpcResult(message.id, {});
    if (!this.initialized) return notification ? null : rpcError(message.id, -32002, "Server not initialized");
    if (message.method === "tools/list") return notification ? null : rpcResult(message.id, { tools: TOOL_DEFINITIONS });
    if (message.method === "tools/call") {
      if (notification) return null;
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      if (typeof name !== "string" || !args || typeof args !== "object" || Array.isArray(args)) {
        return rpcError(message.id, -32602, "Invalid params");
      }
      try {
        const result = await callTool(this.runtime, name, args);
        return rpcResult(message.id, toolResult(result, false));
      } catch (error) {
        return rpcResult(message.id, toolResult(publicError(error), true));
      }
    }
    return notification ? null : rpcError(message.id, -32601, "Method not found");
  }
}

function toolResult(result, isError) {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
    isError,
  };
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
