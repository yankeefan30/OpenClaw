import path from "node:path";
import { pathToFileURL } from "node:url";
import { POLL_INTERVAL_MS } from "./definition.mjs";
import { OutlookMailMonitorEngine } from "./engine.mjs";
import { assertPrivateFile, defaultGrantPath, defaultStateDirectory, ensurePrivateDirectory, readPrivateGrant } from "./grant.mjs";
import { MonitorStateStore } from "./state-store.mjs";

export class OutlookMailMonitorService {
  constructor({ api, setIntervalFn = setInterval, clearIntervalFn = clearInterval, now = () => new Date() }) {
    this.api = api;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.now = now;
    this.timer = null;
    this.running = null;
    this.engine = null;
    this.snapshot = {
      schema: "rico.outlook-mail-monitor-status",
      schemaVersion: 1,
      state: "stopped",
      enabled: this.api.pluginConfig?.enabled === true,
      pollIntervalSeconds: POLL_INTERVAL_MS / 1_000,
      lastPollAt: null,
      lastErrorCode: null,
      alertsConfirmed: 0,
    };
  }

  status() {
    return Object.freeze({ ...this.snapshot });
  }

  async start() {
    if (this.api.pluginConfig?.enabled !== true) {
      this.snapshot = { ...this.snapshot, state: "disabled", enabled: false };
      return;
    }
    this.snapshot = { ...this.snapshot, state: "starting", enabled: true };
    try {
      this.engine = await this.loadEngine();
    } catch (error) {
      this.markBlocked(error);
    }
    await this.tick();
    this.timer = this.setIntervalFn(() => void this.tick(), POLL_INTERVAL_MS);
  }

  async stop() {
    if (this.timer !== null) this.clearIntervalFn(this.timer);
    this.timer = null;
    if (this.running) await this.running;
    this.snapshot = { ...this.snapshot, state: "stopped" };
  }

  async tick() {
    if (this.running) return this.running;
    this.running = this.performTick();
    try {
      return await this.running;
    } finally {
      this.running = null;
    }
  }

  async performTick() {
    const lastPollAt = this.now().toISOString();
    try {
      this.engine ??= await this.loadEngine();
      const result = await this.engine.runOnce();
      this.snapshot = {
        ...this.snapshot,
        state: result.deliveryUnknown > 0 ? "attention" : "running",
        lastPollAt,
        lastErrorCode: result.deliveryUnknown > 0 ? "delivery_outcome_unknown" : null,
        alertsConfirmed: this.snapshot.alertsConfirmed + result.alertsConfirmed,
      };
      return result;
    } catch (error) {
      this.markBlocked(error, lastPollAt);
      return { status: "blocked", errorCode: safeCode(error) };
    }
  }

  async loadEngine() {
    const permissionFile = absoluteConfigPath(this.api, "permissionFile", defaultGrantPath());
    const stateDirectory = absoluteConfigPath(this.api, "stateDirectory", defaultStateDirectory());
    const adapterModule = absoluteConfigPath(this.api, "adapterModule");
    assertPrivateFile(adapterModule);
    ensurePrivateDirectory(stateDirectory);
    const permissionGrant = readPrivateGrant(permissionFile);
    const imported = await import(pathToFileURL(adapterModule).href);
    if (typeof imported.createOutlookMailMonitorAdapter !== "function") throw coded("adapter_factory_missing");
    const adapter = await imported.createOutlookMailMonitorAdapter({
      api: this.api,
      permissionGrant,
      stateDirectory,
    });
    return new OutlookMailMonitorEngine({
      permissionGrant,
      adapter,
      store: new MonitorStateStore(path.join(stateDirectory, "state.json")),
      now: this.now,
    });
  }

  markBlocked(error, at = this.snapshot.lastPollAt) {
    const code = safeCode(error);
    const changed = this.snapshot.lastErrorCode !== code || this.snapshot.state !== "blocked";
    this.snapshot = { ...this.snapshot, state: "blocked", lastPollAt: at, lastErrorCode: code };
    if (changed) this.api.logger.error?.(`Outlook mail monitor blocked (${code})`);
  }
}

function absoluteConfigPath(api, key, fallback) {
  const value = String(api.pluginConfig?.[key] ?? fallback ?? "").trim();
  if (!value || !path.isAbsolute(value)) throw coded(`${key}_absolute_path_required`);
  return path.normalize(value);
}

function safeCode(error) {
  const value = String(error?.code ?? error?.name ?? "unknown");
  return value.toLowerCase().replace(/[^a-z0-9_-]+/gu, "_").slice(0, 80) || "unknown";
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
