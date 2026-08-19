export const SERVER_NAME = "rico-pressmaster-mcp";
export const SERVER_VERSION = "0.1.0";
export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26"]);

export const DEFAULT_BIND_HOST = "127.0.0.1";
export const DEFAULT_PORT = 18793;
export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export const PRESSMASTER_RESOURCE = "https://app.pressmaster.ai/mcp";
export const PRESSMASTER_ISSUER = "https://app.pressmaster.ai/oauth/mcp";
export const PRESSMASTER_AUTHORIZATION_ENDPOINT = "https://app.pressmaster.ai/oauth/mcp/auth";
export const PRESSMASTER_TOKEN_ENDPOINT = "https://app.pressmaster.ai/oauth/mcp/token";
export const PRESSMASTER_REGISTRATION_ENDPOINT = "https://app.pressmaster.ai/oauth/mcp/reg";
export const PRESSMASTER_PROTECTED_RESOURCE_METADATA = "https://app.pressmaster.ai/.well-known/oauth-protected-resource/mcp";
export const PRESSMASTER_SCOPES = "openid offline_access mcp";

export const KEYCHAIN_SERVICE = "rico-pressmaster-mcp";
export const KEYCHAIN_ACCOUNT = "alan";
export const CREDENTIAL_SCHEMA = "rico.pressmaster.oauth-bundle";
export const CREDENTIAL_VERSION = 1;

export const ALLOWED_HOSTNAMES = Object.freeze(["rico.local", "rico"]);
export const ALLOWED_LOCAL_HOST_NAMES = Object.freeze(["rico"]);

export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_LINE_BYTES = 1024 * 1024;
export const TOKEN_REFRESH_SKEW_MS = 60_000;

export const LOCAL_TOOL_NAMES = Object.freeze([
  "rico_pressmaster_health",
  "rico_pressmaster_whoami",
  "rico_pressmaster_list_drafts",
  "rico_pressmaster_get_draft",
  "rico_pressmaster_create_or_update_draft",
  "rico_pressmaster_list_channels",
  "rico_pressmaster_publish_or_schedule",
  "rico_pressmaster_twin_generate",
]);

export const LINKEDIN_ARTICLE_NOTE =
  "Pressmaster's documented LinkedIn path publishes standard LinkedIn posts, not LinkedIn-native articles (LinkedIn's API does not allow article publish). Long-form article drafts still live in the Pressmaster Content Library.";
