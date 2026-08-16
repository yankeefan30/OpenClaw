import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { OWNED_MANIFEST_SCHEMA, OWNERSHIP_MARKER, planRollback, rollbackBadRudy, writeOwnedManifest } from "../rollback.mjs";
import { atomicWritePrivateJson, ensurePrivateDirectory, locations } from "../security.mjs";
import { makeHome, removeHome } from "./helpers.mjs";

test("rollback moves only manifest-owned paths to Trash and preserves unrelated state", async (t) => {
  const home = makeHome();
  t.after(() => removeHome(home));
  const paths = locations(home);
  ensurePrivateDirectory(paths.stateRoot);
  ensurePrivateDirectory(path.dirname(paths.openClawConfigPath));
  ensurePrivateDirectory(path.join(home, ".Trash"));
  ensurePrivateDirectory(path.dirname(paths.launchAgentPath));
  fs.writeFileSync(paths.launchAgentPath, "owned launch agent", { mode: 0o600 });
  fs.chmodSync(paths.launchAgentPath, 0o600);
  const artifact = path.join(paths.artifactRoot, "2026-08-15");
  ensurePrivateDirectory(artifact);
  fs.writeFileSync(path.join(artifact, "keep.mp4"), "keep", { mode: 0o600 });
  const config = {
    unrelated: { keep: true },
    studio: { badRudy: { _ownedBy: OWNERSHIP_MARKER, enabled: true } },
  };
  atomicWritePrivateJson(paths.openClawConfigPath, config);
  writeOwnedManifest(paths.manifestPath, {
    schema: OWNED_MANIFEST_SCHEMA,
    schemaVersion: 1,
    ownedPaths: [
      { path: paths.stateRoot, kind: "directory", role: "state" },
      { path: paths.launchAgentPath, kind: "file", role: "launch-agent" },
    ],
    configKeys: [
      { file: paths.openClawConfigPath, segments: ["studio", "badRudy"], ownershipMarker: OWNERSHIP_MARKER },
    ],
  }, home);

  const plan = planRollback({ homeDirectory: home });
  assert.equal(plan.targets.length, 2);
  assert.equal(plan.configChanges.length, 1);
  const dry = await rollbackBadRudy({ homeDirectory: home, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(fs.existsSync(paths.stateRoot), true);

  const launchCalls = [];
  const result = await rollbackBadRudy({
    homeDirectory: home,
    execFileFn: async (...args) => { launchCalls.push(args); return { stdout: "", stderr: "" }; },
    now: () => new Date("2026-08-15T18:00:00.000Z"),
  });
  assert.equal(result.moved.length, 2);
  assert.equal(launchCalls[0][0], "/bin/launchctl");
  assert.deepEqual(launchCalls[0][1], ["bootout", `gui/${process.getuid()}`, paths.launchAgentPath]);
  assert.equal(fs.existsSync(paths.stateRoot), false);
  assert.equal(fs.existsSync(paths.launchAgentPath), false);
  assert.equal(fs.existsSync(path.join(artifact, "keep.mp4")), true, "dated captures are not rollback-owned state");
  const updatedConfig = JSON.parse(fs.readFileSync(paths.openClawConfigPath, "utf8"));
  assert.deepEqual(updatedConfig.unrelated, { keep: true });
  assert.equal(Object.hasOwn(updatedConfig.studio, "badRudy"), false);
  assert.ok(fs.readdirSync(path.dirname(paths.openClawConfigPath)).some((name) => name.startsWith("openclaw.json.backup.")), "config edit must create a timestamped backup");
  assert.equal(fs.existsSync(result.movedTo), true, "rollback is recoverable from Trash");
});

test("rollback rejects paths and config values without exact ownership", (t) => {
  const home = makeHome();
  t.after(() => removeHome(home));
  const paths = locations(home);
  ensurePrivateDirectory(paths.stateRoot);
  assert.throws(() => writeOwnedManifest(paths.manifestPath, {
    schema: OWNED_MANIFEST_SCHEMA,
    schemaVersion: 1,
    ownedPaths: [{ path: home, kind: "directory", role: "broad" }],
    configKeys: [],
  }, home), { code: "rollback_path_unowned" });

  ensurePrivateDirectory(path.dirname(paths.openClawConfigPath));
  atomicWritePrivateJson(paths.openClawConfigPath, { studio: { badRudy: { enabled: true } } });
  writeOwnedManifest(paths.manifestPath, {
    schema: OWNED_MANIFEST_SCHEMA,
    schemaVersion: 1,
    ownedPaths: [{ path: paths.stateRoot, kind: "directory", role: "state" }],
    configKeys: [{ file: paths.openClawConfigPath, segments: ["studio", "badRudy"], ownershipMarker: OWNERSHIP_MARKER }],
  }, home);
  assert.throws(() => planRollback({ homeDirectory: home }), { code: "rollback_config_unowned" });
});
