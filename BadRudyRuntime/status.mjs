import fs from "node:fs";
import { BadRudyConfigStore, defaultConfig } from "./config.mjs";
import { MacOSGrokCredentialProvider } from "./keychain.mjs";
import { safeError } from "./errors.mjs";
import { validateFeatureMarker } from "./installer.mjs";
import {
  assertPrivateDirectoryChain,
  assertPrivateRegularFileInside,
  locations,
  readPrivateJson,
} from "./security.mjs";
import { StdioPlaywrightWorkerClient } from "./worker-client.mjs";

export const HOST_STATUS_SCHEMA = "openclaw.bad-rudy-host-status/v1";

/**
 * Read-only status for the Swift host. It never invents the prompt, Rico
 * recipient/rate authority, or reviewed delivery adapters, so capture and
 * delivery remain unavailable from this standalone CLI contract.
 */
export async function readOnlyHostStatus({
  homeDirectory,
  nodeExecutable = process.execPath,
  credentialProvider = new MacOSGrokCredentialProvider(),
  worker,
} = {}) {
  const paths = locations(homeDirectory);
  const reasons = [];
  let installed = false;
  let markerCode = "feature_not_installed";
  if (fs.existsSync(paths.featureMarkerPath)) {
    try {
      assertPrivateDirectoryChain(paths.home, paths.installedRuntimeRoot);
      validateFeatureMarker(readPrivateJson(paths.featureMarkerPath, null));
      installed = true;
      markerCode = "ok";
    } catch (error) {
      markerCode = safeError(error).code;
    }
  }
  if (!installed) reasons.push(markerCode);

  let config = defaultConfig();
  let configCode = "default_unmaterialized";
  try {
    const store = new BadRudyConfigStore(paths.configPath, { privateAnchor: paths.home });
    if (store.exists()) {
      config = store.read();
      configCode = "ok";
    }
  } catch (error) {
    config = defaultConfig();
    configCode = safeError(error).code;
    reasons.push(configCode);
  }

  const keychain = await safeStatusProbe(credentialProvider, "status", { available: false, code: "keychain_provider_unavailable" });
  if (keychain.available !== true) reasons.push("keychain_missing");

  let workerClient = worker ?? null;
  let workerPathCode = null;
  if (!workerClient && installed && fs.existsSync(paths.installedWorkerRoot)) {
    try {
      assertPrivateDirectoryChain(paths.home, paths.installedWorkerRoot);
      const workerEntry = assertPrivateRegularFileInside(paths.installedWorkerRoot, `${paths.installedWorkerRoot}/index.ts`);
      workerClient = new StdioPlaywrightWorkerClient({
        nodeExecutable,
        workerEntry,
        homeDirectory: paths.home,
      });
    } catch (error) {
      workerPathCode = safeError(error).code;
    }
  }
  const workerStatus = await safeStatusProbe(workerClient, "health", {
    ready: false,
    playwright: "down",
    ffmpeg: "down",
    capabilities: { "grok:companions:bad-rudy": false },
    code: workerPathCode ?? "worker_unavailable",
  });
  if (workerStatus.capabilities?.["grok:companions:bad-rudy"] !== true) reasons.push("bad_rudy_web_capability_unavailable");
  if (workerStatus.playwright !== "ready" || workerStatus.ffmpeg !== "ready") reasons.push("playwright_worker_down");
  if (config.killSwitch) reasons.push("kill_switch_on");
  if (config.allowedRecipients.length === 0) reasons.push("allowlist_empty");

  // These authorities belong to the signed Studio host / loopback Gateway and
  // are intentionally unavailable to this standalone read-only command.
  reasons.push("prompt_filter_unbound", "rico_authority_unbound", "reviewed_delivery_unbound");
  return Object.freeze({
    schema: HOST_STATUS_SCHEMA,
    schemaVersion: 1,
    readOnly: true,
    installed,
    marker: Object.freeze({ ready: installed, code: markerCode, path: paths.featureMarkerPath }),
    config: Object.freeze({
      code: configCode,
      killSwitch: config.killSwitch,
      dryRun: config.dryRun,
      allowlistCount: config.allowedRecipients.length,
    }),
    keychain: Object.freeze({ ready: keychain.available === true, code: keychain.available === true ? "ok" : String(keychain.code ?? "keychain_missing") }),
    worker: Object.freeze({
      ready: workerStatus.ready === true,
      playwright: workerStatus.playwright === "ready" ? "ready" : "down",
      ffmpeg: workerStatus.ffmpeg === "ready" ? "ready" : "down",
      badRudyWebCapability: workerStatus.capabilities?.["grok:companions:bad-rudy"] === true,
      code: String(workerStatus.code ?? "worker_unavailable"),
    }),
    captureReady: false,
    deliveryReady: false,
    reasons: Object.freeze([...new Set(reasons)]),
  });
}

async function safeStatusProbe(target, method, fallback) {
  try {
    if (!target || typeof target[method] !== "function") return fallback;
    const result = await target[method]();
    return result && typeof result === "object" ? result : fallback;
  } catch {
    return fallback;
  }
}
