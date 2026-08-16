import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  BUNDLED_RUNTIME_DIRECTORY,
  BUNDLED_RUNTIME_FILES,
  BUNDLED_WORKER_DIRECTORY,
  BUNDLED_WORKER_FILES,
  FEATURE_MARKER_SCHEMA,
  installBadRudy,
} from "../installer.mjs";
import { BadRudyConfigStore } from "../config.mjs";
import { rollbackBadRudy } from "../rollback.mjs";
import { ensurePrivateDirectory, locations } from "../security.mjs";
import { makeHome, removeHome } from "./helpers.mjs";

const execFile = promisify(execFileCallback);
const repositoryRoot = path.resolve(import.meta.dirname, "..", "..");

test("offline install copies only fixed bundled files and creates private fail-closed state", (t) => {
  const home = makeHome();
  const fixture = makeBundleFixture(home);
  t.after(() => removeHome(home));
  const result = installBadRudy({
    homeDirectory: home,
    resourcesRoot: fixture,
    testOnlyAllowUnbundledResources: true,
    now: () => new Date("2026-08-15T19:00:00.000Z"),
  });
  const target = locations(home);

  assert.equal(result.offline, true);
  assert.equal(result.launchAgentInstalled, false);
  assert.equal(result.openClawConfigChanged, false);
  assert.equal(result.backupPath, null);
  assert.deepEqual(listRelativeFiles(target.installedRuntimeRoot), [...BUNDLED_RUNTIME_FILES, "feature.json"].sort());
  assert.deepEqual(listRelativeFiles(target.installedWorkerRoot), [...BUNDLED_WORKER_FILES].sort());
  assertPrivateTree(target.installedRuntimeRoot);
  assertPrivateTree(target.installedWorkerRoot);

  const marker = JSON.parse(fs.readFileSync(target.featureMarkerPath, "utf8"));
  assert.deepEqual(marker, {
    schema: FEATURE_MARKER_SCHEMA,
    schemaVersion: 1,
    _ownedBy: "openclaw-studio:bad-rudy",
  });
  assert.equal(fs.statSync(target.featureMarkerPath).mode & 0o777, 0o600);
  const config = new BadRudyConfigStore(target.configPath).read();
  assert.equal(config.killSwitch, true);
  assert.equal(config.dryRun, true);
  assert.deepEqual(config.allowedRecipients, []);
  const manifest = JSON.parse(fs.readFileSync(target.manifestPath, "utf8"));
  assert.deepEqual(manifest.ownedPaths.map((entry) => entry.path), [
    target.installedRuntimeRoot,
    target.installedWorkerRoot,
    target.stateRoot,
  ]);
  assert.deepEqual(manifest.configKeys, []);
  assert.equal(fs.existsSync(target.launchAgentPath), false);
  assert.equal(fs.existsSync(target.openClawConfigPath), false);
});

test("a standard macOS 0750 home is accepted while managed descendants stay 0700", (t) => {
  const home = makeHome();
  t.after(() => removeHome(home));
  fs.chmodSync(home, 0o750);
  const resources = makeBundleFixture(home);

  const result = installBadRudy({
    homeDirectory: home,
    resourcesRoot: resources,
    testOnlyAllowUnbundledResources: true,
  });

  assert.equal(result.installed, true);
  assert.equal(fs.statSync(home).mode & 0o777, 0o750);
  assert.equal(fs.statSync(path.dirname(result.runtimePath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(result.runtimePath).mode & 0o777, 0o700);
});

test("reinstall preserves config and moves prior owned code into a timestamped backup", (t) => {
  const home = makeHome();
  const fixture = makeBundleFixture(home);
  t.after(() => removeHome(home));
  const runtimeReadme = path.join(fixture, BUNDLED_RUNTIME_DIRECTORY, "README.md");
  fs.writeFileSync(runtimeReadme, "runtime generation one\n", { mode: 0o600 });
  installBadRudy({ homeDirectory: home, resourcesRoot: fixture, testOnlyAllowUnbundledResources: true });
  const target = locations(home);
  const store = new BadRudyConfigStore(target.configPath);
  store.write({
    ...store.read(),
    killSwitch: false,
    dryRun: false,
    allowedRecipients: ["+16469433060"],
  });

  fs.writeFileSync(runtimeReadme, "runtime generation two\n", { mode: 0o600 });
  const result = installBadRudy({
    homeDirectory: home,
    resourcesRoot: fixture,
    testOnlyAllowUnbundledResources: true,
    now: () => new Date("2026-08-15T20:30:45.123Z"),
  });
  assert.match(result.backupPath, /2026-08-15T20-30-45-123Z$/u);
  assert.equal(fs.readFileSync(path.join(result.backupPath, "bad-rudy", "README.md"), "utf8"), "runtime generation one\n");
  assert.equal(fs.readFileSync(path.join(target.installedRuntimeRoot, "README.md"), "utf8"), "runtime generation two\n");
  const preserved = store.read();
  assert.equal(preserved.killSwitch, false);
  assert.equal(preserved.dryRun, false);
  assert.deepEqual(preserved.allowedRecipients, ["+16469433060"]);
  assert.equal(result.createdConfig, false);
  assert.equal(result.createdMarker, false);
  assert.equal(fs.existsSync(target.openClawConfigPath), false);
  assert.equal(fs.existsSync(target.launchAgentPath), false);
});

test("installer refuses pre-existing unmarked code and linked bundle files", (t) => {
  const home = makeHome();
  const fixture = makeBundleFixture(home);
  t.after(() => removeHome(home));
  const target = locations(home);
  ensurePrivateDirectory(target.installedRuntimeRoot);
  fs.writeFileSync(path.join(target.installedRuntimeRoot, "user-file"), "preserve", { mode: 0o600 });
  assert.throws(() => installBadRudy({ homeDirectory: home, resourcesRoot: fixture, testOnlyAllowUnbundledResources: true }), { code: "existing_install_unowned" });
  assert.equal(fs.readFileSync(path.join(target.installedRuntimeRoot, "user-file"), "utf8"), "preserve");

  const cleanHome = makeHome();
  t.after(() => removeHome(cleanHome));
  const linkedFixture = makeBundleFixture(cleanHome);
  const sourceFile = path.join(linkedFixture, BUNDLED_WORKER_DIRECTORY, "selectors.ts");
  fs.unlinkSync(sourceFile);
  fs.symlinkSync(path.join(repositoryRoot, "workers", "grok-companions", "selectors.ts"), sourceFile);
  assert.throws(() => installBadRudy({ homeDirectory: cleanHome, resourcesRoot: linkedFixture, testOnlyAllowUnbundledResources: true }), { code: "bundle_source_unsafe" });
});

test("installed manifest rolls back module, worker, and state while preserving dated media", async (t) => {
  const home = makeHome();
  const fixture = makeBundleFixture(home);
  t.after(() => removeHome(home));
  installBadRudy({ homeDirectory: home, resourcesRoot: fixture, testOnlyAllowUnbundledResources: true });
  const target = locations(home);
  const day = path.join(target.artifactRoot, "2026-08-15");
  ensurePrivateDirectory(day);
  fs.writeFileSync(path.join(day, "keep.mp4"), "capture", { mode: 0o600 });
  ensurePrivateDirectory(path.join(home, ".Trash"));
  const result = await rollbackBadRudy({ homeDirectory: home, now: () => new Date("2026-08-15T21:00:00.000Z") });
  assert.deepEqual(result.moved.map((entry) => entry.from), [
    target.installedRuntimeRoot,
    target.installedWorkerRoot,
    target.stateRoot,
  ]);
  assert.equal(fs.existsSync(target.installedRuntimeRoot), false);
  assert.equal(fs.existsSync(target.installedWorkerRoot), false);
  assert.equal(fs.existsSync(target.stateRoot), false);
  assert.equal(fs.existsSync(path.join(day, "keep.mp4")), true);
});

test("production CLI installs only from its exact app Resources layout", async (t) => {
  const root = makeHome();
  t.after(() => removeHome(root));
  const home = path.join(root, "operator-home");
  fs.mkdirSync(home, { mode: 0o700 });
  const resources = path.join(root, "OpenClaw Studio.app", "Contents", "Resources");
  makeBundleFixture(root, resources);
  const cli = path.join(resources, BUNDLED_RUNTIME_DIRECTORY, "scripts", "bad-rudy.mjs");
  const { stdout, stderr } = await execFile(process.execPath, [cli, "--install-bad-rudy"], {
    env: { HOME: home, PATH: "/usr/bin:/bin" },
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(stderr, "");
  const result = JSON.parse(stdout);
  assert.equal(result.installed, true);
  assert.equal(result.offline, true);
  assert.equal(result.runtimePath, locations(home).installedRuntimeRoot);
  assert.equal(fs.existsSync(locations(home).openClawConfigPath), false);
  assert.equal(fs.existsSync(locations(home).launchAgentPath), false);
});

function makeBundleFixture(home, resources = path.join(home, "bundle-resources")) {
  const runtimeSource = path.join(repositoryRoot, "BadRudyRuntime");
  const workerSource = path.join(repositoryRoot, "workers", "grok-companions");
  const runtimeDestination = path.join(resources, BUNDLED_RUNTIME_DIRECTORY);
  const workerDestination = path.join(resources, BUNDLED_WORKER_DIRECTORY);
  fs.mkdirSync(runtimeDestination, { recursive: true, mode: 0o700 });
  fs.mkdirSync(workerDestination, { recursive: true, mode: 0o700 });
  copyFiles(runtimeSource, runtimeDestination, BUNDLED_RUNTIME_FILES);
  copyFiles(workerSource, workerDestination, BUNDLED_WORKER_FILES);
  return resources;
}

function copyFiles(sourceRoot, destinationRoot, files) {
  for (const relative of files) {
    const destination = path.join(destinationRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(sourceRoot, relative), destination);
    fs.chmodSync(destination, 0o600);
  }
}

function listRelativeFiles(root) {
  const result = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(child);
      else result.push(path.relative(root, child).split(path.sep).join("/"));
    }
  };
  visit(root);
  return result.sort();
}

function assertPrivateTree(root) {
  const visit = (entry) => {
    const stat = fs.lstatSync(entry);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.mode & 0o777, stat.isDirectory() ? 0o700 : 0o600);
    if (stat.isDirectory()) for (const child of fs.readdirSync(entry)) visit(path.join(entry, child));
  };
  visit(root);
}
