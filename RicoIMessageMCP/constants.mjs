import os from "node:os";
import path from "node:path";

export const SERVER_NAME = "rico-imessage-mcp";
export const NOTION_SERVER_NAME = "rico-notion-mcp";
export const SERVER_VERSION = "0.4.1";
export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);

export const DEFAULT_BIND_HOST = "127.0.0.1";
export const DEFAULT_PORT = 18791;
export const DEFAULT_NOTION_PORT = 18792;
export const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";

export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_TEXT_CHARS = 4_000;
export const MAX_IDEMPOTENCY_CHARS = 128;
export const MAX_INBOX_ITEMS = 15;
export const MAX_MAIL_ACCOUNTS = 32;
export const MAX_MAILBOX_NAME_CHARS = 80;
export const DEFAULT_MAILBOX_NAME = "INBOX";
export const MAX_MAIL_BODY_CHARS = 8_000;
export const MAX_SUBJECT_CHARS = 160;
export const MAX_CALENDAR_DAYS = 14;
export const DEFAULT_CALENDAR_DAYS = 7;
export const MAX_CALENDAR_EVENTS = 25;
export const MAX_CALENDAR_EXPORT_EVENTS = 80;
export const MAX_CALENDAR_NAMES = 64;
export const NOTION_CVS_CALENDAR_DATABASE_ID = "2d7750e6-a650-4612-a06e-8fe5f515e1a8";
export const NOTION_CVS_CALENDAR_DATA_SOURCE_ID = "9c72cdde-4189-431d-b4f5-77e47fb36042";
export const NOTION_CVS_CALENDAR_URL = "https://app.notion.com/p/2d7750e6a6504612a06e8fe5f515e1a8";
export const MAX_CALENDAR_TITLE_CHARS = 160;
export const MAX_CALENDAR_NOTES_CHARS = 2_000;
export const MAX_EVENT_DURATION_DAYS = 14;

export const MAIL_BUNDLE_ID = "com.apple.mail";
export const CALENDAR_BUNDLE_ID = "com.apple.iCal";
export const OUTLOOK_BUNDLE_ID = "com.microsoft.Outlook";
export const DEFAULT_MAIL_APP_PATH = "/System/Applications/Mail.app";
export const DEFAULT_CALENDAR_APP_PATH = "/System/Applications/Calendar.app";
export const DEFAULT_OUTLOOK_APP_PATH = "/Applications/Microsoft Outlook.app";

export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function studioSupportDirectory(home = os.homedir()) {
  return path.join(home, "Library", "Application Support", "OpenClaw Studio");
}

export function defaultTokenDirectory(home = os.homedir()) {
  return path.join(studioSupportDirectory(home), "secrets");
}

export function defaultTokenPath(home = os.homedir()) {
  return path.join(defaultTokenDirectory(home), "rico-imessage-mcp.token");
}

export function defaultNotionTokenPath(home = os.homedir()) {
  return path.join(defaultTokenDirectory(home), "rico-notion-mcp.token");
}

export function defaultPolicyPath(home = os.homedir()) {
  return path.join(studioSupportDirectory(home), "rico-recipient-guard.json");
}

export function defaultOpenClawConfigPath(home = os.homedir()) {
  return path.join(home, ".openclaw", "openclaw.json");
}

export function defaultEmailAuthorizationPath(home = os.homedir()) {
  return path.join(studioSupportDirectory(home), "rico-email-governance", "person-authorizations.json");
}
