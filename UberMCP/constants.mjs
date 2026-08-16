import os from "node:os";
import path from "node:path";

export const SERVER_NAME = "openclaw-uber-governed";
export const SERVER_VERSION = "0.2.0";
export const KEYCHAIN_SERVICE = "openclaw-uber";
export const KEYCHAIN_ACCOUNT = "alan";
export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26"]);

export const API_ORIGINS = Object.freeze({
  production: "https://api.uber.com",
  sandbox: "https://sandbox-api.uber.com",
});
export const OAUTH_ORIGIN = "https://auth.uber.com";
export const API_VERSION = "v1.2";

export const RIDE_STATUSES = new Set([
  "processing",
  "no_drivers_available",
  "accepted",
  "arriving",
  "in_progress",
  "driver_canceled",
  "rider_canceled",
  "completed",
]);

export const TERMINAL_RIDE_STATUSES = new Set([
  "rider_canceled",
  "driver_canceled",
  "completed",
  "no_drivers_available",
]);

export const CANCELLATION_NOTICE =
  "Uber may charge a cancellation fee after a ride request is accepted. The Riders API estimate does not return a guaranteed cancellation-fee amount; review the current Uber terms before confirming cancellation.";

export function defaultStateDirectory() {
  return path.join(os.homedir(), "Library", "Application Support", "OpenClaw Studio", "uber-mcp");
}
