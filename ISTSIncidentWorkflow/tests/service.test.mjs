import assert from "node:assert/strict";
import test from "node:test";
import { POLL_INTERVAL_MS } from "../definition.mjs";
import { ISTSIncidentService } from "../service.mjs";

test("service is disabled by default and does not load private adapters or schedule polling", async () => {
  let scheduled = 0;
  const api = { pluginConfig: {}, logger: { error() { throw new Error("disabled service must not log an error"); } } };
  const service = new ISTSIncidentService({
    api,
    setIntervalFn() { scheduled += 1; return 1; },
  });
  await service.start();
  assert.equal(service.status().state, "disabled");
  assert.equal(service.status().enabled, false);
  assert.equal(service.status().pollIntervalSeconds, 180);
  assert.equal(scheduled, 0);
});

test("enabled service uses exactly one three-minute non-overlapping timer", async () => {
  let scheduledInterval = null;
  let callback = null;
  const service = new ISTSIncidentService({
    api: { pluginConfig: { enabled: true }, logger: {} },
    setIntervalFn(fn, interval) { callback = fn; scheduledInterval = interval; return 7; },
    clearIntervalFn() {},
  });
  let runs = 0;
  service.loadMonitorRuntime = async () => {
    service.engine = {
      async runOnce() {
        runs += 1;
        return {
          status: "ok",
          alertsConfirmed: 0,
          deliveryUnknown: 0,
          suppressedCooldown: 0,
          research: "not-started",
        };
      },
    };
    service.contextProvider = {};
  };
  await service.start();
  assert.equal(runs, 1);
  assert.equal(scheduledInterval, POLL_INTERVAL_MS);
  assert.equal(typeof callback, "function");
  assert.equal(service.status().state, "running");
  await service.stop();
});

test("service surfaces interactive Colleague Zone re-auth without credential or MFA data", async () => {
  const service = new ISTSIncidentService({
    api: { pluginConfig: { enabled: true }, logger: {} },
    setIntervalFn() { return 8; },
  });
  const blocker = Object.assign(new Error("colleague_zone_reauth_required"), {
    code: "colleague_zone_reauth_required",
    reauth: {
      url: "https://colleaguezone.cvs.com/cz?id=services_status",
    },
  });
  service.loadMonitorRuntime = async () => {
    service.engine = { grant: { colleagueZone: { enabled: true } }, async runOnce() { throw blocker; } };
    service.contextProvider = {};
  };
  await service.start();
  const status = service.status();
  assert.equal(status.state, "blocked");
  assert.equal(status.lastErrorCode, "colleague_zone_reauth_required");
  assert.equal(status.colleagueZoneState, "reauth-required");
  assert.equal(status.colleagueZoneReauthRequired, true);
  assert.equal(status.colleagueZoneReauthURL, "https://colleaguezone.cvs.com/cz?id=services_status");
  assert.equal(status.colleagueZoneReauthMethod, "dedicated-browser");
  assert.equal(JSON.stringify(status).includes("password"), false);
  assert.equal(JSON.stringify(status).includes("otp"), false);
});

test("dedicated any-local-group ingress runs on the same non-overlapping tick and reports live separately", async () => {
  const service = new ISTSIncidentService({
    api: { pluginConfig: { enabled: true, anyGroupEnabled: true }, logger: {} },
    setIntervalFn() { return 9; },
  });
  let groupRuns = 0;
  service.loadMonitorRuntime = async () => {
    service.engine = {
      grant: { colleagueZone: { enabled: false } },
      async runOnce() {
        return { alertsConfirmed: 0, deliveryUnknown: 0, suppressedCooldown: 0, research: "not-started" };
      },
    };
    service.contextProvider = {};
  };
  service.loadAnyGroupRuntime = async () => {
    service.anyGroupEngine = {
      async runOnce() {
        groupRuns += 1;
        return { status: "ok", baseline: true, inspected: 4, qualified: 0, delivered: 0, outcomeUnknown: 0 };
      },
    };
  };
  await service.start();
  const status = service.status();
  assert.equal(groupRuns, 1);
  assert.equal(status.anyLocalGroupAuthorized, true);
  assert.equal(status.anyLocalGroupInstalled, true);
  assert.equal(status.anyLocalGroupLive, true);
  assert.equal(status.anyLocalGroupState, "baseline");
  assert.equal(status.anyLocalGroupInspected, 4);
  assert.equal(status.generalRicoPolicyBroadened, false);
  assert.equal(status.nativeAllowlistBroadened, false);
  await service.stop();
});

test("a primary monitor failure does not prevent the dedicated any-local-group poll from completing", async () => {
  const errors = [];
  const service = new ISTSIncidentService({
    api: { pluginConfig: { enabled: true, anyGroupEnabled: true }, logger: { error(value) { errors.push(value); } } },
    setIntervalFn() { return 10; },
  });
  let groupRuns = 0;
  service.loadMonitorRuntime = async () => {
    service.engine = {
      grant: { colleagueZone: { enabled: false } },
      async runOnce() { throw Object.assign(new Error("monitor blocked"), { code: "monitor_blocked" }); },
    };
    service.contextProvider = {};
  };
  service.loadAnyGroupRuntime = async () => {
    service.anyGroupEngine = {
      async runOnce() {
        groupRuns += 1;
        return { status: "ok", baseline: false, inspected: 1, qualified: 1, delivered: 1, outcomeUnknown: 0 };
      },
    };
  };
  await service.start();
  const status = service.status();
  assert.equal(groupRuns, 1);
  assert.equal(status.state, "attention");
  assert.equal(status.lastErrorCode, "monitor_blocked");
  assert.equal(status.anyLocalGroupState, "running");
  assert.equal(status.anyLocalGroupLive, true);
  assert.equal(status.anyLocalGroupDelivered, 1);
  assert.equal(errors.length, 1);
  await service.stop();
});

test("any-local-group ingress starts independently while the monitor and Colleague Zone path are disabled", async () => {
  const service = new ISTSIncidentService({
    api: { pluginConfig: { enabled: false, anyGroupEnabled: true }, logger: {} },
    setIntervalFn() { return 11; },
  });
  let groupRuns = 0;
  service.loadMonitorRuntime = async () => {
    throw new Error("disabled monitor must not load");
  };
  service.loadAnyGroupRuntime = async () => {
    service.anyGroupEngine = {
      async runOnce() {
        groupRuns += 1;
        return { status: "ok", baseline: false, inspected: 1, qualified: 1, delivered: 1, outcomeUnknown: 0 };
      },
    };
  };
  await service.start();
  const status = service.status();
  assert.equal(groupRuns, 1);
  assert.equal(status.monitorEnabled, false);
  assert.equal(status.anyLocalGroupEnabled, true);
  assert.equal(status.anyLocalGroupAuthorized, true);
  assert.equal(status.anyLocalGroupInstalled, true);
  assert.equal(status.anyLocalGroupLive, true);
  assert.equal(status.anyLocalGroupState, "running");
  assert.equal(status.state, "running");
  await service.stop();
});
