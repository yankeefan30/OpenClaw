import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Runtime snapshots are intentionally allowlisted. Uber's refresh-token
// rotation helper is source-only so secret bytes can move from stdin directly
// into Security.framework without ever appearing in argv, env, or a temp file.
const ALLOWED_SOURCE_NAMES = new Set(["package.json", "README.md", "KeychainWriteHelper.swift"]);

export function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

export function writePrivateJson(filePath, value) {
  ensurePrivateDirectory(path.dirname(filePath));
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.chmodSync(temporaryPath, 0o600);
  fs.renameSync(temporaryPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

export function readPrivateJson(filePath) {
  assertRegularFile(filePath);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function sha256File(filePath) {
  assertRegularFile(filePath);
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function copyRuntimeModule(sourceDirectory, destinationDirectory) {
  assertDirectoryWithoutLink(sourceDirectory);
  if (fs.existsSync(destinationDirectory)) throw new Error(`Install destination already exists: ${destinationDirectory}`);
  ensurePrivateDirectory(destinationDirectory);
  const records = [];
  copyDirectory(sourceDirectory, destinationDirectory, sourceDirectory, records);
  return Object.freeze(records.sort((left, right) => left.relativePath.localeCompare(right.relativePath)));
}

function copyDirectory(sourceDirectory, destinationDirectory, sourceRoot, records) {
  for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const sourcePath = path.join(sourceDirectory, entry.name);
    const relativePath = path.relative(sourceRoot, sourcePath);
    const stat = fs.lstatSync(sourcePath);
    if (stat.isSymbolicLink()) throw new Error(`Runtime source must not contain symbolic links: ${sourcePath}`);
    if (entry.isDirectory()) {
      if (entry.name === "tests" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const targetDirectory = path.join(destinationDirectory, entry.name);
      ensurePrivateDirectory(targetDirectory);
      copyDirectory(sourcePath, targetDirectory, sourceRoot, records);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Unsupported runtime source entry: ${sourcePath}`);
    if (!entry.name.endsWith(".mjs") && !ALLOWED_SOURCE_NAMES.has(entry.name)) continue;
    const targetPath = path.join(destinationDirectory, entry.name);
    fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(targetPath, 0o600);
    records.push(Object.freeze({
      relativePath,
      path: targetPath,
      sha256: sha256File(targetPath),
      bytes: fs.statSync(targetPath).size,
    }));
  }
}

export function makeTimestamp(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(value.getTime())) throw new Error("Invalid integration timestamp.");
  return value.toISOString().replace(/[:.]/gu, "-");
}

export function createConfigBackup(configPath, backupDirectory, date = new Date(), phase = "install") {
  ensurePrivateDirectory(backupDirectory);
  const timestamp = makeTimestamp(date);
  const baseName = `openclaw.pre-mobility-dining-${phase}.${timestamp}`;
  if (!fs.existsSync(configPath)) {
    const markerPath = path.join(backupDirectory, `${baseName}.missing.json`);
    writePrivateJson(markerPath, {
      schema: "openclaw.mobility-dining.missing-config-backup",
      version: 1,
      configPath,
      absentAt: new Date(date).toISOString(),
    });
    return Object.freeze({ path: markerPath, originalExisted: false, sha256: sha256File(markerPath) });
  }
  assertRegularFile(configPath);
  const backupPath = path.join(backupDirectory, `${baseName}.json`);
  fs.copyFileSync(configPath, backupPath, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backupPath, 0o600);
  return Object.freeze({ path: backupPath, originalExisted: true, sha256: sha256File(backupPath) });
}

export function removeOwnedFiles(records, allowedRoot) {
  const resolvedRoot = path.resolve(allowedRoot);
  const removed = [];
  const preserved = [];
  const directories = new Set();
  for (const record of records ?? []) {
    const target = path.resolve(record.path);
    assertDescendant(target, resolvedRoot);
    directories.add(path.dirname(target));
    if (!fs.existsSync(target)) continue;
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || sha256File(target) !== record.sha256) {
      preserved.push(target);
      continue;
    }
    fs.unlinkSync(target);
    removed.push(target);
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) removeEmptyAncestors(directory, resolvedRoot);
  return Object.freeze({ removed: Object.freeze(removed), preserved: Object.freeze(preserved) });
}

function removeEmptyAncestors(start, root) {
  let current = path.resolve(start);
  while (current !== root && current.startsWith(`${root}${path.sep}`)) {
    if (!fs.existsSync(current)) {
      current = path.dirname(current);
      continue;
    }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(current).length !== 0) return;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

export function assertRegularFile(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular file: ${filePath}`);
}

export function assertDirectoryWithoutLink(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Expected a real directory: ${directory}`);
}

export function assertDescendant(target, root) {
  if (target === root || !target.startsWith(`${root}${path.sep}`)) throw new Error(`Refusing path outside the owned integration root: ${target}`);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function exactJsonEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}
