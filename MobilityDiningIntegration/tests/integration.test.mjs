import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exactServerEntry, SECURITY_BLOCKERS, SERVER_DEFINITIONS } from "../constants.mjs";
import { integrationHealth } from "../health.mjs";
import { installIntegration, rollbackIntegration } from "../installer.mjs";

class FakeRegistry {
  constructor(initial = {}) {
    this.entries = structuredClone(initial);
    this.validations = 0;
  }
  get(name) { return Object.hasOwn(this.entries, name) ? structuredClone(this.entries[name]) : null; }
  set(name, value) { this.entries[name] = structuredClone(value); }
  unset(name) { delete this.entries[name]; }
  validateConfig() { this.validations += 1; }
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mobility-dining-integration-"));
  const baseDirectory = path.join(root, "private");
  const paths = {
    baseDirectory,
    configPath: path.join(root, "openclaw.json"),
    stateDirectory: path.join(root, "state"),
    backupDirectory: path.join(baseDirectory, "backups"),
    releaseDirectory: path.join(baseDirectory, "releases"),
    transactionPath: path.join(baseDirectory, "pending-install.json"),
    manifestPath: path.join(baseDirectory, "manifest.json"),
    etaOutboxDirectory: path.join(baseDirectory, "eta-outbox"),
  };
  fs.writeFileSync(paths.configPath, JSON.stringify({ unrelated: { remains: true } }));
  return { root, paths };
}

test("installer snapshots both modules privately and registers exact disabled entries", (t) => {
  const { root, paths } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = new FakeRegistry({ untouched: { command: "/bin/true" } });
  const result = installIntegration({
    paths,
    registry,
    nodePath: process.execPath,
    repositoryRoot: path.resolve(import.meta.dirname, "../.."),
    now: () => new Date("2026-08-15T18:00:00.000Z"),
  });
  assert.equal(result.ok, true);
  assert.equal(result.enabled, false);
  assert.deepEqual(registry.entries.untouched, { command: "/bin/true" });
  for (const definition of SERVER_DEFINITIONS) {
    const entry = registry.entries[definition.id];
    assert.equal(entry.enabled, false);
    assert.deepEqual(entry.toolFilter.include, definition.modelTools);
    assert.equal(entry.command, process.execPath);
    assert.match(entry.args[0], new RegExp(`${definition.installDirectory}/index\\.mjs$`, "u"));
    assert.equal(fs.statSync(entry.cwd).mode & 0o777, 0o700);
    assert.equal(fs.statSync(entry.args[0]).mode & 0o777, 0o600);
  }
  assert.equal(registry.entries["rico-uber"].toolFilter.include.includes("uber_monitor_tick"), false);
  assert.equal(registry.entries["rico-uber"].toolFilter.include.includes("uber_location_search"), true);
  assert.equal(registry.entries["rico-uber"].toolFilter.include.includes("uber_location_resolve"), true);
  const uberHelper = path.join(registry.entries["rico-uber"].cwd, "KeychainWriteHelper.swift");
  assert.equal(fs.existsSync(uberHelper), true);
  assert.equal(fs.statSync(uberHelper).mode & 0o777, 0o600);
  assert.equal(fs.statSync(paths.manifestPath).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(paths.backupDirectory).length, 1);
});

test("rollback removes only exact owned registry entries and unchanged owned files", (t) => {
  const { root, paths } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = new FakeRegistry({ untouched: { command: "/bin/true" } });
  installIntegration({ paths, registry, nodePath: process.execPath, repositoryRoot: path.resolve(import.meta.dirname, "../..") });
  const modifiedEntry = registry.entries["rico-uber"];
  modifiedEntry.timeout = 99;
  registry.entries["rico-uber"] = modifiedEntry;
  const result = rollbackIntegration({ paths, registry, nodePath: process.execPath, repositoryRoot: path.resolve(import.meta.dirname, "../..") });
  assert.equal(result.ok, false);
  assert.equal(registry.get("rico-opentable"), null);
  assert.equal(registry.get("rico-uber").timeout, 99);
  assert.deepEqual(registry.entries.untouched, { command: "/bin/true" });
  assert.equal(result.results.find((item) => item.id === "rico-uber").files, "preserved");
});

test("installer refuses registry name collisions", (t) => {
  const { root, paths } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = new FakeRegistry({ "rico-opentable": { command: "/custom/server" } });
  assert.throws(() => installIntegration({ paths, registry, nodePath: process.execPath, repositoryRoot: path.resolve(import.meta.dirname, "../..") }), /Refusing to replace/u);
  assert.deepEqual(registry.get("rico-opentable"), { command: "/custom/server" });
});

test("health stays non-operational and reports every security blocker", (t) => {
  const { root, paths } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = new FakeRegistry();
  installIntegration({ paths, registry, nodePath: process.execPath, repositoryRoot: path.resolve(import.meta.dirname, "../..") });
  const status = integrationHealth({ paths, registry, nodePath: process.execPath, repositoryRoot: path.resolve(import.meta.dirname, "../.."), protocolProbe: false, keychainProbe: false });
  assert.equal(status.ok, true);
  assert.equal(status.operational, false);
  assert.equal(status.enabled, false);
  assert.deepEqual(status.securityBlockers.map((item) => item.code), SECURITY_BLOCKERS.map((item) => item.code));
  assert.ok(status.services.every((service) => service.registryDisabled && !service.operational));
});

test("server entry contract is disabled and contains no secret-bearing fields", () => {
  for (const definition of SERVER_DEFINITIONS) {
    const entry = exactServerEntry(definition, `/private/${definition.installDirectory}`, process.execPath);
    assert.equal(entry.enabled, false);
    assert.equal(Object.hasOwn(entry, "env"), false);
    assert.doesNotMatch(JSON.stringify(entry), /token|secret|cookie|password/iu);
  }
});
