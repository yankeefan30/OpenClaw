import { authorizeWorkflowTool } from "./allowlist.mjs";
import {
  MCP_PROTOCOL_VERSION,
  MCP_WORKFLOW_ID,
  SERVER_NAME,
  SERVER_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "./constants.mjs";
import { fail, publicError } from "./errors.mjs";
import { MCP_TOOL_DEFINITIONS } from "./mcp-tools.mjs";
import { callBridgeTool, isForbiddenTool } from "./tools.mjs";

export class RicoLindyMcpServer {
  constructor({ runtime, allowlist } = {}) {
    this.runtime = runtime;
    this.allowlist = allowlist;
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
        instructions: "Thin local bridge on original Rico.local. Tools: health, mailbox_names, outlook_list_inbox, outlook_search, outlook_get, outlook_draft (no send), calendar_names, calendar_list, calendar_upsert (no attendees). Lindy is the speaker. iMessage, Apple Mail, outlook_send, Teams, Slack, and general chat are not on this server. This is not the OpenClaw Gateway.",
      });
    }
    if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return null;
    if (message.method === "ping") return notification ? null : rpcResult(message.id, {});
    if (!this.initialized) return notification ? null : rpcError(message.id, -32002, "Server not initialized");
    if (message.method === "tools/list") return notification ? null : rpcResult(message.id, { tools: MCP_TOOL_DEFINITIONS });
    if (message.method === "tools/call") {
      if (notification) return null;
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      if (typeof name !== "string" || !args || typeof args !== "object" || Array.isArray(args)) {
        return rpcError(message.id, -32602, "Invalid params");
      }
      if (isForbiddenTool(name) || args.prompt || args.messages || args.session || args.chat) {
        return rpcResult(message.id, toolResult(publicError(fail(
          "tool_not_allowed",
          "That tool is not on the Lindy local-bridge surface.",
          { status: 403 },
        )), true));
      }
      try {
        const authorized = authorizeWorkflowTool({
          allowlist: this.allowlist,
          workflowId: resolveWorkflowId(message.params),
          tool: name,
        });
        const result = await callBridgeTool(this.runtime, authorized.tool, stripWorkflowId(args));
        return rpcResult(message.id, toolResult(result, false));
      } catch (error) {
        return rpcResult(message.id, toolResult(publicError(error), true));
      }
    }
    return notification ? null : rpcError(message.id, -32601, "Method not found");
  }
}

export function resolveWorkflowId(params = {}) {
  const fromArgs = String(params?.arguments?.workflowId ?? "").trim();
  if (fromArgs) return fromArgs;
  const fromMeta = String(params?._meta?.workflowId ?? "").trim();
  if (fromMeta) return fromMeta;
  return MCP_WORKFLOW_ID;
}

function stripWorkflowId(args) {
  const { workflowId: _ignored, ...rest } = args;
  return rest;
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
