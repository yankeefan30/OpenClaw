import { MCP_PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "./constants.mjs";
import { publicError } from "./errors.mjs";
import { callTool, listOfficialAndLocalTools, TOOL_DEFINITIONS } from "./tools.mjs";

export class RicoPressmasterMcpServer {
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
        instructions:
          "Rico-local Pressmaster MCP on original Rico only. Draft and Twin tools never publish. Use rico_pressmaster_publish_or_schedule only when Alan explicitly asks to publish or schedule, and prefer dryRun during QA. Hosted https://app.pressmaster.ai/mcp OAuth from Grok Bot is unused here.",
      });
    }
    if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return null;
    if (message.method === "ping") return notification ? null : rpcResult(message.id, {});
    if (!this.initialized) return notification ? null : rpcError(message.id, -32002, "Server not initialized");
    if (message.method === "tools/list") {
      if (notification) return null;
      const tools = await listOfficialAndLocalTools(this.runtime);
      return rpcResult(message.id, { tools: tools.length ? tools : TOOL_DEFINITIONS });
    }
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
