import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BadRudyConfigStore, defaultConfig } from "../config.mjs";
import { featureMarker } from "../installer.mjs";
import { locations, atomicWritePrivateJson, ensurePrivateDirectoryChain } from "../security.mjs";
import { HOST_STATUS_SCHEMA, readOnlyHostStatus } from "../status.mjs";
import { fakeCredentialProvider, fakeWorker, makeHome, removeHome } from "./helpers.mjs";

test("standalone status is read-only and never invents host authorities", async (t) => {
  const home = makeHome();
  t.after(() => removeHome(home));
  const paths = locations(home);

  const status = await readOnlyHostStatus({
    homeDirectory: home,
    credentialProvider: fakeCredentialProvider(),
    worker: fakeWorker({ capability: true }),
  });

  assert.equal(status.schema, HOST_STATUS_SCHEMA);
  assert.equal(status.readOnly, true);
  assert.equal(status.installed, false);
  assert.equal(status.captureReady, false);
  assert.equal(status.deliveryReady, false);
  assert.equal(status.keychain.ready, true);
  assert.equal(status.worker.badRudyWebCapability, true);
  assert.ok(status.reasons.includes("feature_not_installed"));
  assert.ok(status.reasons.includes("prompt_filter_unbound"));
  assert.ok(status.reasons.includes("rico_authority_unbound"));
  assert.ok(status.reasons.includes("reviewed_delivery_unbound"));
  assert.equal(fs.existsSync(paths.artifactRoot), false);
  assert.equal(fs.existsSync(paths.installedRuntimeRoot), false);
  assert.equal(fs.existsSync(paths.installedWorkerRoot), false);
});

test("installed marker and fail-closed config remain unavailable without signed host adapters", async (t) => {
  const home = makeHome();
  t.after(() => removeHome(home));
  const paths = locations(home);
  ensurePrivateDirectoryChain(home, paths.installedRuntimeRoot);
  atomicWritePrivateJson(paths.featureMarkerPath, featureMarker());
  new BadRudyConfigStore(paths.configPath, { privateAnchor: home }).write(defaultConfig());

  const status = await readOnlyHostStatus({
    homeDirectory: home,
    credentialProvider: fakeCredentialProvider(),
    worker: fakeWorker({ capability: true }),
  });

  assert.equal(status.installed, true);
  assert.equal(status.marker.code, "ok");
  assert.deepEqual(status.config, {
    code: "ok",
    killSwitch: true,
    dryRun: true,
    allowlistCount: 0,
  });
  assert.equal(status.captureReady, false);
  assert.equal(status.deliveryReady, false);
  assert.ok(status.reasons.includes("kill_switch_on"));
  assert.ok(status.reasons.includes("allowlist_empty"));
  assert.ok(status.reasons.includes("rico_authority_unbound"));
});

test("status rejects a marker reached through a symlinked module parent", async (t) => {
  const home = makeHome();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "bad-rudy-status-outside-"));
  fs.chmodSync(outside, 0o700);
  t.after(() => {
    removeHome(home);
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const paths = locations(home);
  const moduleParent = path.dirname(paths.installedRuntimeRoot);
  ensurePrivateDirectoryChain(home, moduleParent);
  atomicWritePrivateJson(path.join(outside, "feature.json"), featureMarker());
  fs.symlinkSync(outside, paths.installedRuntimeRoot);

  const status = await readOnlyHostStatus({
    homeDirectory: home,
    credentialProvider: fakeCredentialProvider(),
    worker: fakeWorker({ capability: true }),
  });

  assert.equal(status.installed, false);
  assert.equal(status.marker.code, "unsafe_state_directory");
  assert.equal(status.captureReady, false);
  assert.equal(status.deliveryReady, false);
});
