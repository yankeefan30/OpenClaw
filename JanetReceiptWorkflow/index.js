import path from "node:path";
import { pathToFileURL } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { defaultGrantPath, defaultStateDirectory, readPrivateGrant } from "./grant.mjs";
import { runJanetReceiptWorkflow } from "./handler.mjs";
import { ReceiptLedger } from "./ledger.mjs";
import { parseInboundRequest, WorkflowPolicyError } from "./policy.mjs";
import { FileReportStore } from "./report-store.mjs";

const PLUGIN_ID = "rico-janet-receipt";

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Rico Janet Receipt Workflow",
  register(api) {
    let runtimePromise;
    const runtime = () => {
      runtimePromise ??= loadRuntime(api);
      return runtimePromise;
    };

    api.on("inbound_claim", async (event) => {
      let loaded;
      try {
        loaded = await runtime();
      } catch (error) {
        // If the private grant can still authenticate this as a matching Janet
        // request, claim it silently rather than letting an ungoverned agent
        // improvise. All other traffic remains in OpenClaw's normal path.
        try {
          const grant = readPrivateGrant(configPath(api, "permissionFile", defaultGrantPath()));
          parseInboundRequest(event, grant, new Date());
          api.logger.error?.(`Janet receipt workflow unavailable (${safeCode(error)}); request claimed without side effects`);
          return { handled: true };
        } catch (policyError) {
          if (!(policyError instanceof WorkflowPolicyError)) {
            api.logger.error?.(`Janet receipt workflow grant unavailable (${safeCode(policyError)})`);
          }
          return;
        }
      }

      try {
        const result = await runJanetReceiptWorkflow({
          event,
          permissionGrant: loaded.permissionGrant,
          ledger: loaded.ledger,
          services: loaded.services,
          reporter: loaded.reporter,
        });
        return result.handled ? { handled: true } : undefined;
      } catch (error) {
        api.logger.error?.(`Janet receipt workflow failed closed (${safeCode(error)})`);
        return { handled: true };
      }
    }, { priority: 1_000, timeoutMs: 600_000 });
  },
});

async function loadRuntime(api) {
  const permissionFile = configPath(api, "permissionFile", defaultGrantPath());
  const stateDirectory = configPath(api, "stateDirectory", defaultStateDirectory());
  const adapterModule = configPath(api, "adapterModule");
  const permissionGrant = readPrivateGrant(permissionFile);
  const imported = await import(pathToFileURL(adapterModule).href);
  if (typeof imported.createServices !== "function") throw new Error("adapter_create_services_missing");
  const services = await imported.createServices({ api, permissionGrant });
  return {
    permissionGrant,
    services,
    ledger: new ReceiptLedger(path.join(stateDirectory, "ledger.json")),
    reporter: new FileReportStore(path.join(stateDirectory, "reports")),
  };
}

function configPath(api, key, fallback) {
  const value = String(api.pluginConfig?.[key] ?? fallback ?? "").trim();
  if (!value || !path.isAbsolute(value)) throw new Error(`${key}_absolute_path_required`);
  return path.normalize(value);
}

function safeCode(error) {
  const value = String(error?.code ?? error?.name ?? "unknown");
  return value.toLowerCase().replace(/[^a-z0-9_-]+/gu, "_").slice(0, 80) || "unknown";
}
