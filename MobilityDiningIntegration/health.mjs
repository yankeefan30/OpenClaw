import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SECURITY_BLOCKERS, SERVER_DEFINITIONS } from "./constants.mjs";
import { createContext, loadManifest } from "./installer.mjs";
import { exactJsonEqual, sha256File } from "./private-files.mjs";

export function integrationHealth(options = {}) {
  const context = createContext(options);
  const manifest = loadManifest(context.paths);
  if (!manifest) {
    return Object.freeze({
      ok: true,
      installed: false,
      operational: false,
      enabled: false,
      securityBlockers: SECURITY_BLOCKERS,
      services: Object.freeze([]),
    });
  }
  const services = manifest.servers.map((server) => serviceHealth(context, server, options));
  const installedHealthy = services.every((service) => service.filesIntact && service.protocolHealthy && service.registryExact && service.registryDisabled);
  return Object.freeze({
    ok: installedHealthy,
    installed: true,
    installState: manifest.state,
    operational: false,
    enabled: false,
    configPath: context.paths.configPath,
    manifestPath: fs.existsSync(context.paths.manifestPath) ? context.paths.manifestPath : context.paths.transactionPath,
    securityBlockers: SECURITY_BLOCKERS,
    browserSessionAcceptedAsCredential: false,
    services: Object.freeze(services),
  });
}

function serviceHealth(context, server, options) {
  const definition = SERVER_DEFINITIONS.find((candidate) => candidate.id === server.id);
  const fileFailures = [];
  for (const record of server.files ?? []) {
    try {
      if (sha256File(record.path) !== record.sha256) fileFailures.push(record.relativePath);
    } catch {
      fileFailures.push(record.relativePath);
    }
  }
  const current = context.registry.get(server.id);
  const registryExact = current !== null && exactJsonEqual(current, server.entry);
  const registryDisabled = current?.enabled === false;
  const protocol = options.protocolProbe === false ? { ok: true, skipped: true } : probeStdioTools(context.nodePath, path.join(server.installedDirectory, definition.entrypoint), definition);
  const keychainItemPresent = options.keychainProbe === false ? null : keychainMetadataExists(definition.keychain, options.securitySpawn ?? spawnSync);
  return Object.freeze({
    id: server.id,
    service: server.service,
    installedDirectory: server.installedDirectory,
    filesIntact: fileFailures.length === 0,
    changedOrMissingFiles: Object.freeze(fileFailures),
    registryExact,
    registryDisabled,
    protocolHealthy: protocol.ok,
    protocol,
    keychainItemPresent,
    keychainBundleValidated: false,
    enabled: false,
    operational: false,
  });
}

export function keychainMetadataExists(keychain, spawn = spawnSync) {
  const result = spawn("/usr/bin/security", ["find-generic-password", "-s", keychain.service, "-a", keychain.account], {
    stdio: "ignore",
    timeout: 5_000,
    env: { PATH: "/usr/bin:/bin" },
  });
  return result.status === 0;
}

export function probeStdioTools(nodePath, entrypoint, definition) {
  const script = [
    "import { spawn } from 'node:child_process';",
    "const child = spawn(process.argv[1], [process.argv[2]], {stdio:['pipe','pipe','ignore'], env:{PATH:'/usr/bin:/bin'}});",
    "let output=''; child.stdout.setEncoding('utf8'); child.stdout.on('data', d => output += d);",
    "child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'mobility-dining-health',version:'1'}}})+'\\n');",
    "child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}})+'\\n'); child.stdin.end();",
    "const timer=setTimeout(()=>child.kill('SIGTERM'),3000); child.on('close',()=>{clearTimeout(timer); process.stdout.write(output)});",
  ].join("");
  const result = spawnSync(nodePath, ["--input-type=module", "-e", script, nodePath, entrypoint], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
    env: { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" },
  });
  if (result.status !== 0) return Object.freeze({ ok: false, error: "stdio_probe_failed" });
  try {
    const messages = String(result.stdout ?? "").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const listed = messages.find((message) => message.id === 2)?.result?.tools;
    const names = Array.isArray(listed) ? listed.map((tool) => tool.name).sort() : [];
    const expected = [...definition.modelTools, ...definition.schedulerTools].sort();
    return Object.freeze({ ok: exactJsonEqual(names, expected), tools: Object.freeze(names) });
  } catch {
    return Object.freeze({ ok: false, error: "stdio_probe_invalid_response" });
  }
}

