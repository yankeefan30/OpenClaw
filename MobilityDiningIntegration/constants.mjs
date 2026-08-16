import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const INTEGRATION_SCHEMA = "openclaw.mobility-dining.integration";
export const INTEGRATION_VERSION = 1;
export const RELEASE_VERSION = "0.2.0";

export const DEFAULT_NODE_PATH = "/opt/homebrew/opt/node/bin/node";
export const DEFAULT_OPENCLAW_ENTRY = "/opt/homebrew/lib/node_modules/openclaw/dist/index.js";

export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const SECURITY_BLOCKERS = Object.freeze([
  Object.freeze({
    code: "guard_tool_injection_not_integrated",
    severity: "p0",
    services: Object.freeze(["opentable", "uber"]),
    detail: "The installed guard has not yet been reviewed and deployed as the sole before_tool_call proof injector for these MCP tools; OpenTable also still needs the v2 canonical-arguments/tool-call replay contract before activation.",
  }),
  Object.freeze({
    code: "opentable_proof_v2_missing",
    severity: "p0",
    services: Object.freeze(["opentable"]),
    detail: "OpenTable binds owner, message, conversation, run, action, and expiry, but it does not yet bind canonical tool arguments and toolCallId to a durably consumed one-shot proof as Uber does.",
  }),
  Object.freeze({
    code: "provider_credentials_not_reviewed",
    severity: "p1",
    services: Object.freeze(["opentable", "uber"]),
    detail: "Official provider credentials and approvals must be installed in the exact Keychain items and pass each server's full preflight before either entry can be enabled.",
  }),
  Object.freeze({
    code: "uber_geocoder_adapter_missing",
    severity: "p0",
    services: Object.freeze(["uber"]),
    detail: "Uber's opaque location-reference flow is implemented, but no reviewed server-side geocoder adapter is configured; the default adapter intentionally fails closed.",
  }),
  Object.freeze({
    code: "uber_eta_sender_adapter_missing",
    severity: "p1",
    services: Object.freeze(["uber"]),
    detail: "Uber persists acknowledged ETA events, but the reviewed owner-only iMessage sender and scheduler handoff are not installed.",
  }),
  Object.freeze({
    code: "reviewed_enablement_missing",
    severity: "p1",
    services: Object.freeze(["opentable", "uber"]),
    detail: "This installer deliberately creates disabled entries only; a separate reviewed activation flow must verify credentials, guard hooks, exact tool policy, rate limits, and rollback before enabling either server.",
  }),
]);

const OPENTABLE_MODEL_TOOLS = Object.freeze([
  "opentable_status",
  "opentable_restaurant_search",
  "opentable_availability_search",
  "opentable_booking_preview",
  "opentable_booking_hold",
  "opentable_booking_confirm",
  "opentable_reservations_list",
  "opentable_cancel_preview",
  "opentable_cancel_confirm",
]);

const UBER_MODEL_TOOLS = Object.freeze([
  "uber_status",
  "uber_location_search",
  "uber_location_resolve",
  "uber_products_estimate",
  "uber_create_reviewed_challenge",
  "uber_confirm_request",
  "uber_current_status",
  "uber_cancel_preview",
  "uber_cancel_confirm",
]);

export const SERVER_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "rico-opentable",
    service: "opentable",
    sourceDirectory: "OpenTableMCP",
    installDirectory: "opentable",
    entrypoint: "index.mjs",
    keychain: Object.freeze({ service: "openclaw-opentable", account: "alan" }),
    modelTools: OPENTABLE_MODEL_TOOLS,
    schedulerTools: Object.freeze([]),
  }),
  Object.freeze({
    id: "rico-uber",
    service: "uber",
    sourceDirectory: "UberMCP",
    installDirectory: "uber",
    entrypoint: "index.mjs",
    keychain: Object.freeze({ service: "openclaw-uber", account: "alan" }),
    modelTools: UBER_MODEL_TOOLS,
    schedulerTools: Object.freeze([]),
  }),
]);

export function defaultPaths(environment = process.env) {
  const userHome = environment.HOME || os.homedir();
  const baseDirectory = path.join(userHome, "Library", "Application Support", "OpenClaw Studio", "MobilityDiningIntegration");
  const configPath = environment.OPENCLAW_CONFIG_PATH || path.join(userHome, ".openclaw", "openclaw.json");
  const stateDirectory = environment.OPENCLAW_STATE_DIR || path.join(userHome, ".openclaw");
  return Object.freeze({
    baseDirectory,
    configPath: path.resolve(configPath),
    stateDirectory: path.resolve(stateDirectory),
    backupDirectory: path.join(baseDirectory, "backups"),
    releaseDirectory: path.join(baseDirectory, "releases"),
    transactionPath: path.join(baseDirectory, "pending-install.json"),
    manifestPath: path.join(baseDirectory, "manifest.json"),
    etaOutboxDirectory: path.join(baseDirectory, "eta-outbox"),
  });
}

export function exactServerEntry(definition, installedDirectory, nodePath = DEFAULT_NODE_PATH) {
  return Object.freeze({
    command: path.resolve(nodePath),
    args: Object.freeze([path.join(installedDirectory, definition.entrypoint)]),
    cwd: installedDirectory,
    enabled: false,
    timeout: 45,
    connectTimeout: 10,
    toolFilter: Object.freeze({ include: definition.modelTools }),
  });
}
