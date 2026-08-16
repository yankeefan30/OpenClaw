import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_NODE_PATH,
  DEFAULT_OPENCLAW_ENTRY,
  INTEGRATION_SCHEMA,
  INTEGRATION_VERSION,
  RELEASE_VERSION,
  REPOSITORY_ROOT,
  SECURITY_BLOCKERS,
  SERVER_DEFINITIONS,
  defaultPaths,
  exactServerEntry,
} from "./constants.mjs";
import { OpenClawMcpRegistry } from "./openclaw-cli.mjs";
import {
  copyRuntimeModule,
  createConfigBackup,
  ensurePrivateDirectory,
  exactJsonEqual,
  makeTimestamp,
  readPrivateJson,
  removeOwnedFiles,
  writePrivateJson,
} from "./private-files.mjs";

export function createContext(options = {}) {
  const paths = Object.freeze({ ...defaultPaths(options.environment), ...(options.paths ?? {}) });
  const nodePath = path.resolve(options.nodePath ?? DEFAULT_NODE_PATH);
  const openclawEntry = path.resolve(options.openclawEntry ?? DEFAULT_OPENCLAW_ENTRY);
  const registry = options.registry ?? new OpenClawMcpRegistry({
    nodePath,
    openclawEntry,
    configPath: paths.configPath,
    stateDirectory: paths.stateDirectory,
  });
  return Object.freeze({
    paths,
    nodePath,
    openclawEntry,
    repositoryRoot: path.resolve(options.repositoryRoot ?? REPOSITORY_ROOT),
    now: options.now ?? (() => new Date()),
    registry,
  });
}

export function installIntegration(options = {}) {
  const context = createContext(options);
  const { paths } = context;
  ensurePrivateDirectory(paths.baseDirectory);
  ensurePrivateDirectory(paths.backupDirectory);
  ensurePrivateDirectory(paths.releaseDirectory);
  if (fs.existsSync(paths.manifestPath)) {
    return Object.freeze({ ok: true, installed: true, alreadyInstalled: true, manifestPath: paths.manifestPath });
  }
  if (fs.existsSync(paths.transactionPath)) {
    throw new Error(`An incomplete install transaction exists at ${paths.transactionPath}; run rollback before retrying.`);
  }
  for (const definition of SERVER_DEFINITIONS) {
    if (context.registry.get(definition.id) !== null) {
      throw new Error(`Refusing to replace pre-existing MCP server ${definition.id}.`);
    }
  }

  const startedAt = context.now();
  const releaseId = `${makeTimestamp(startedAt)}-${crypto.randomUUID()}`;
  const releaseRoot = path.join(paths.releaseDirectory, releaseId);
  ensurePrivateDirectory(releaseRoot);
  const installedServers = [];
  for (const definition of SERVER_DEFINITIONS) {
    const sourceDirectory = path.join(context.repositoryRoot, definition.sourceDirectory);
    const installedDirectory = path.join(releaseRoot, definition.installDirectory);
    const files = copyRuntimeModule(sourceDirectory, installedDirectory);
    const entry = exactServerEntry(definition, installedDirectory, context.nodePath);
    installedServers.push({
      id: definition.id,
      service: definition.service,
      installedDirectory,
      entry,
      files,
      keychain: definition.keychain,
      modelTools: definition.modelTools,
      schedulerTools: definition.schedulerTools,
      registryWritten: false,
    });
  }

  const backup = createConfigBackup(paths.configPath, paths.backupDirectory, startedAt, "install");
  const transaction = {
    schema: INTEGRATION_SCHEMA,
    version: INTEGRATION_VERSION,
    releaseVersion: RELEASE_VERSION,
    state: "installing",
    releaseId,
    releaseRoot,
    configPath: paths.configPath,
    configBackup: backup,
    createdAt: startedAt.toISOString(),
    securityBlockers: SECURITY_BLOCKERS,
    servers: installedServers,
  };
  writePrivateJson(paths.transactionPath, transaction);

  try {
    for (const server of transaction.servers) {
      context.registry.set(server.id, server.entry);
      server.registryWritten = true;
      writePrivateJson(paths.transactionPath, transaction);
      const saved = context.registry.get(server.id);
      if (!exactJsonEqual(saved, server.entry)) throw new Error(`OpenClaw did not preserve the exact disabled MCP entry for ${server.id}.`);
    }
    context.registry.validateConfig();
    transaction.state = "installed-disabled";
    transaction.installedAt = context.now().toISOString();
    writePrivateJson(paths.manifestPath, transaction);
    fs.unlinkSync(paths.transactionPath);
    return Object.freeze({
      ok: true,
      installed: true,
      enabled: false,
      manifestPath: paths.manifestPath,
      configBackupPath: backup.path,
      servers: Object.freeze(transaction.servers.map((server) => Object.freeze({ id: server.id, enabled: false }))),
      blockers: SECURITY_BLOCKERS,
    });
  } catch (error) {
    const cleanupErrors = compensateFailedInstall(context, transaction);
    const suffix = cleanupErrors.length ? ` Cleanup also failed for: ${cleanupErrors.join(", ")}.` : "";
    throw new Error(`Mobility/dining install failed closed.${suffix}`, { cause: error });
  }
}

function compensateFailedInstall(context, transaction) {
  const failures = [];
  for (const server of [...transaction.servers].reverse()) {
    if (!server.registryWritten) continue;
    try {
      const current = context.registry.get(server.id);
      if (current && exactJsonEqual(current, server.entry)) context.registry.unset(server.id);
      else if (current) failures.push(`${server.id}:entry_changed`);
    } catch {
      failures.push(`${server.id}:registry_cleanup`);
    }
  }
  for (const server of transaction.servers) {
    try {
      const result = removeOwnedFiles(server.files, transaction.releaseRoot);
      if (result.preserved.length) failures.push(`${server.id}:files_changed`);
    } catch {
      failures.push(`${server.id}:file_cleanup`);
    }
  }
  if (failures.length === 0 && fs.existsSync(context.paths.transactionPath)) fs.unlinkSync(context.paths.transactionPath);
  return failures;
}

export function rollbackIntegration(options = {}) {
  const context = createContext(options);
  const { paths } = context;
  const recordPath = fs.existsSync(paths.manifestPath) ? paths.manifestPath : paths.transactionPath;
  if (!fs.existsSync(recordPath)) return Object.freeze({ ok: true, installed: false, changed: false });
  const manifest = readPrivateJson(recordPath);
  validateManifest(manifest);
  const rollbackBackup = createConfigBackup(paths.configPath, paths.backupDirectory, context.now(), "rollback");
  const results = [];
  for (const server of manifest.servers) {
    let registryState = "absent";
    const current = context.registry.get(server.id);
    if (current !== null) {
      if (!exactJsonEqual(current, server.entry)) {
        results.push(Object.freeze({ id: server.id, registry: "preserved_changed", files: "preserved" }));
        continue;
      }
      context.registry.unset(server.id);
      registryState = "removed";
    }
    const fileResult = removeOwnedFiles(server.files, manifest.releaseRoot);
    results.push(Object.freeze({
      id: server.id,
      registry: registryState,
      files: fileResult.preserved.length ? "partially_preserved_changed" : "removed",
      preservedFiles: fileResult.preserved,
    }));
  }
  context.registry.validateConfig();
  const unresolved = results.filter((result) => result.registry === "preserved_changed" || result.preservedFiles?.length);
  if (unresolved.length === 0) {
    fs.unlinkSync(recordPath);
  } else {
    manifest.state = "rollback-incomplete";
    manifest.rollbackAttemptedAt = context.now().toISOString();
    manifest.rollbackResults = results;
    writePrivateJson(recordPath, manifest);
  }
  return Object.freeze({
    ok: unresolved.length === 0,
    installed: unresolved.length !== 0,
    changed: true,
    rollbackBackupPath: rollbackBackup.path,
    results: Object.freeze(results),
  });
}

export function loadManifest(paths) {
  if (fs.existsSync(paths.manifestPath)) return readPrivateJson(paths.manifestPath);
  if (fs.existsSync(paths.transactionPath)) return readPrivateJson(paths.transactionPath);
  return null;
}

function validateManifest(value) {
  if (!value || value.schema !== INTEGRATION_SCHEMA || value.version !== INTEGRATION_VERSION || !Array.isArray(value.servers)) {
    throw new Error("The mobility/dining ownership manifest is invalid.");
  }
}

