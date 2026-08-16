import os from "node:os";
import path from "node:path";

export const KEYCHAIN_SERVICE = "openclaw-opentable";
export const KEYCHAIN_ACCOUNT = "alan";
export const SERVER_NAME = "openclaw-opentable-governed";
export const SERVER_VERSION = "0.2.0";
export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-06-18",
  "2025-03-26",
]);

export const OFFICIAL_LINKS = Object.freeze({
  home: "https://www.opentable.com/",
  apiDocs: "https://docs.opentable.com/",
  partnerApplication: "https://www.opentable.com/restaurant-solutions/api-partners/become-a-partner/",
  partnerFaq: "https://www.opentable.com/restaurant-solutions/api-partners/faqs/",
  developerTerms: "https://www.opentable.com/restaurant-solutions/api-partners/terms-and-conditions/",
  apiStatus: "https://status-api.opentable.com/",
});

export const ALL_CAPABILITIES = Object.freeze([
  "directory",
  "availability",
  "booking_policy",
  "cancellation_policy",
  "slot_lock",
  "book",
  "get_reservation",
  "cancel",
]);

export const MUTATING_CAPABILITIES = new Set(["slot_lock", "book", "cancel"]);

export function defaultStateDirectory() {
  return path.join(os.homedir(), "Library", "Application Support", "OpenClaw Studio", "opentable-mcp");
}
