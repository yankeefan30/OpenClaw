import assert from "node:assert/strict";
import test from "node:test";
import { OutlookMailMonitorService } from "../service.mjs";

test("service is disabled by default and creates no timer", async () => {
  let timers = 0;
  const api = { pluginConfig: {}, logger: { error() { throw new Error("disabled service must not log"); } } };
  const service = new OutlookMailMonitorService({
    api,
    setIntervalFn: () => { timers += 1; return 1; },
  });
  await service.start();
  assert.equal(service.status().state, "disabled");
  assert.equal(service.status().pollIntervalSeconds, 90);
  assert.equal(timers, 0);
});

test("overlapping ticks collapse into one engine run", async () => {
  const api = { pluginConfig: {}, logger: {} };
  const service = new OutlookMailMonitorService({ api });
  let release;
  let runs = 0;
  service.engine = {
    runOnce: () => {
      runs += 1;
      return new Promise((resolve) => { release = resolve; });
    },
  };
  const first = service.tick();
  const second = service.tick();
  assert.equal(runs, 1);
  release({ alertsConfirmed: 0, deliveryUnknown: 0 });
  await Promise.all([first, second]);
  assert.equal(service.status().state, "running");
});

test("enabled service retries a setup blocker every 90 seconds without log spam", async () => {
  let delay = 0;
  let logs = 0;
  const api = {
    pluginConfig: { enabled: true },
    logger: { error() { logs += 1; } },
  };
  const service = new OutlookMailMonitorService({
    api,
    setIntervalFn: (_callback, milliseconds) => { delay = milliseconds; return 1; },
    clearIntervalFn: () => {},
  });
  await service.start();
  assert.equal(service.status().state, "blocked");
  assert.equal(service.status().lastErrorCode, "adaptermodule_absolute_path_required");
  assert.equal(delay, 90_000);
  assert.equal(logs, 1);
  await service.tick();
  assert.equal(logs, 1, "identical repeated blocker is retained in status without repeated logs");
  await service.stop();
});
