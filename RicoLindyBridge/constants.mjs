import os from "node:os";
import path from "node:path";
import { studioSupportDirectory } from "../RicoIMessageMCP/constants.mjs";

export const SERVER_NAME = "rico-lindy-bridge";
export const SERVER_VERSION = "0.2.0";
export const DEFAULT_BIND_HOST = "127.0.0.1";
export const DEFAULT_PORT = 18792;
export const BRIDGE_PATH = "/lindy/local-bridge";
export const MCP_PATH = "/lindy/mcp";
export const MCP_WORKFLOW_ID = "lindy-mcp";
export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26"]);
export const MAX_BODY_BYTES = 256 * 1024;

export const BRIDGE_TOOLS = Object.freeze([
  "health",
  "outlook_list_inbox",
  "outlook_search",
  "outlook_get",
  "outlook_draft",
  "calendar_names",
  "mailbox_names",
  "calendar_list",
  "calendar_upsert",
]);

export const FORBIDDEN_TOOLS = Object.freeze([
  "rico_imessage_send",
  "rico_imessage_health",
  "rico_imessage_can_send",
  "rico_mail_list_inbox",
  "rico_mail_get",
  "rico_mail_send",
  "rico_outlook_send",
  "ask",
  "chat",
  "complete",
  "agent",
  "generate",
  "imessage_send",
  "messages_send",
]);

export function defaultTokenPath(home = os.homedir()) {
  return path.join(studioSupportDirectory(home), "secrets", "rico-lindy-bridge.token");
}

export function defaultAllowlistPath(home = os.homedir()) {
  return path.join(studioSupportDirectory(home), "lindy-local-bridge.allowlist.json");
}
