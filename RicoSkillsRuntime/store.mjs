import fsp from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDirectory } from "./archive.mjs";
import { computePackageHash, sha256, stableStringify } from "./canonical.mjs";
import { NON_AUTHORIZING_POLICY, RICO_SKILL_SCHEMA, RICO_SKILL_STAGE_SCHEMA, RICO_SKILL_STATE_SCHEMA } from "./constants.mjs";
import { invariant } from "./errors.mjs";
import { validateStagePath } from "./importer.mjs";
import { scanSecrets, validateRelativePath, validateTextFile } from "./policy.mjs";

export async function installReviewedSkill({ stagePath, libraryRoot, approval }) {
  invariant(approval?.approved === true, "review_required", "Explicit operator review is required before installation.");
  await ensurePrivateDirectory(path.resolve(libraryRoot));
  await ensurePrivateDirectory(path.join(path.resolve(libraryRoot), "quarantine"));
  const resolvedStage = validateStagePath(stagePath, libraryRoot);
  const stage = JSON.parse(await fsp.readFile(path.join(resolvedStage, "stage.json"), "utf8"));
  invariant(stage.schema === RICO_SKILL_STAGE_SCHEMA && stage.status === "awaiting_review", "invalid_stage", "This staged import cannot be installed.");
  invariant(stage.reviewHash === sha256(stableStringify(stage.review)), "review_mismatch", "The staged review changed after quarantine.");
  invariant(typeof stage.reviewToken === "string" && approval.reviewToken === stage.reviewToken, "review_mismatch", "The review approval does not match this staged import.");
  invariant(approval.contentHash === stage.review?.contentHash, "review_mismatch", "The reviewed content changed before installation.");

  const verified = await verifyCanonicalPackage(resolvedStage, { allowStageMetadata: true });
  invariant(verified.manifest.contentHash === approval.contentHash, "review_mismatch", "The canonical package no longer matches the reviewed hash.");
  const installedRoot = path.join(path.resolve(libraryRoot), "installed");
  await ensurePrivateDirectory(installedRoot);
  const skillRoot = path.join(installedRoot, verified.manifest.id);
  await ensurePrivateDirectory(skillRoot);
  const versionsRoot = path.join(skillRoot, "versions");
  await ensurePrivateDirectory(versionsRoot);
  const versionID = `${verified.manifest.version}-${verified.manifest.contentHash.slice(0, 12)}`;
  const versionRoot = path.join(versionsRoot, versionID);
  const incoming = path.join(versionsRoot, `.incoming-${cryptoRandomID()}`);
  if (!(await exists(versionRoot))) {
    await ensurePrivateDirectory(incoming);
    try {
      for (const file of verified.files) await writePrivateFile(incoming, file.relativePath, file.text);
      await writePrivateFile(incoming, "manifest.json", `${JSON.stringify(verified.manifest, null, 2)}\n`);
      await fsp.rename(incoming, versionRoot);
    } catch (error) {
      await removeIncoming(incoming, versionsRoot);
      throw error;
    }
  }

  const previous = await readState(skillRoot);
  const history = [...new Set([...(previous?.history ?? []), versionID])];
  const state = {
    schema: RICO_SKILL_STATE_SCHEMA,
    schemaVersion: 1,
    id: verified.manifest.id,
    activeVersion: versionID,
    enabled: false,
    installedAt: previous?.installedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    history,
  };
  await atomicWriteJSON(path.join(skillRoot, "state.json"), state);
  await markStageInstalled(resolvedStage, stage, versionID);
  return inventoryRecord(verified.manifest, state, versionID);
}

export async function listInstalledSkills(libraryRoot) {
  const root = path.resolve(libraryRoot);
  const installedRoot = path.join(root, "installed");
  try {
    await assertPrivateDirectory(root, "The Rico skills library is not private and owned.");
    await assertPrivateDirectory(installedRoot, "The installed skills directory is not private and owned.");
  }
  catch { return []; }
  const entries = await fsp.readdir(installedRoot, { withFileTypes: true });
  if (entries.length > 256) return [];
  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const skillRoot = path.join(installedRoot, entry.name);
    try {
      await assertPrivateDirectory(skillRoot, "The installed skill directory is not private and owned.");
      await assertPrivateDirectory(path.join(skillRoot, "versions"), "The skill versions directory is not private and owned.");
      const state = await readState(skillRoot);
      if (!state || state.id !== entry.name) continue;
      const versionRoot = validatedVersionRoot(skillRoot, state.activeVersion);
      const verified = await verifyCanonicalPackage(versionRoot);
      if (verified.manifest.id !== entry.name) continue;
      assertVersionIdentity(state.activeVersion, verified.manifest);
      const versions = [];
      for (const versionID of state.history) {
        try {
          const candidate = await verifyCanonicalPackage(validatedVersionRoot(skillRoot, versionID));
          assertVersionIdentity(versionID, candidate.manifest);
          versions.push({
            versionID,
            version: candidate.manifest.version,
            contentHash: candidate.manifest.contentHash,
            importedAt: candidate.manifest.provenance.importedAt,
            active: versionID === state.activeVersion,
          });
        } catch { /* A corrupt historical version is never offered for rollback. */ }
      }
      records.push({ ...inventoryRecord(verified.manifest, state, state.activeVersion), versions });
    } catch { /* Fail closed: corrupt packages disappear from the active inventory. */ }
  }
  return records.sort((a, b) => a.name.localeCompare(b.name));
}

export async function setSkillEnabled({ libraryRoot, skillID, enabled, approval }) {
  const skillRoot = validatedSkillRoot(libraryRoot, skillID);
  await assertPrivateDirectory(skillRoot, "The installed skill directory is not private and owned.");
  await assertPrivateDirectory(path.join(skillRoot, "versions"), "The skill versions directory is not private and owned.");
  const state = await readState(skillRoot);
  invariant(state, "skill_missing", "The selected skill is not installed.");
  const versionRoot = validatedVersionRoot(skillRoot, state.activeVersion);
  const verified = await verifyCanonicalPackage(versionRoot);
  assertVersionIdentity(state.activeVersion, verified.manifest);
  if (enabled) {
    invariant(approval?.approved === true && approval?.contentHash === verified.manifest.contentHash && approval?.acknowledgeNonAuthorizing === true, "enable_review_required", "Enabling requires review of the exact skill version and its non-authorizing boundary.");
  }
  const next = { ...state, enabled: enabled === true, updatedAt: new Date().toISOString() };
  await atomicWriteJSON(path.join(skillRoot, "state.json"), next);
  return inventoryRecord(verified.manifest, next, next.activeVersion);
}

export async function rollbackSkill({ libraryRoot, skillID, versionID, approval }) {
  invariant(approval?.approved === true, "rollback_review_required", "Rollback requires explicit operator review.");
  const skillRoot = validatedSkillRoot(libraryRoot, skillID);
  await assertPrivateDirectory(skillRoot, "The installed skill directory is not private and owned.");
  await assertPrivateDirectory(path.join(skillRoot, "versions"), "The skill versions directory is not private and owned.");
  const state = await readState(skillRoot);
  invariant(state?.history?.includes(versionID), "version_missing", "The selected skill version is not in its version history.");
  const versionRoot = validatedVersionRoot(skillRoot, versionID);
  const verified = await verifyCanonicalPackage(versionRoot);
  assertVersionIdentity(versionID, verified.manifest);
  invariant(approval.contentHash === verified.manifest.contentHash, "review_mismatch", "The rollback approval does not match the selected version.");
  const next = { ...state, activeVersion: versionID, enabled: false, updatedAt: new Date().toISOString() };
  await atomicWriteJSON(path.join(skillRoot, "state.json"), next);
  return inventoryRecord(verified.manifest, next, versionID);
}

export async function verifyCanonicalPackage(packageRoot, { allowStageMetadata = false } = {}) {
  const rootStat = await fsp.lstat(packageRoot);
  invariant(rootStat.isDirectory() && !rootStat.isSymbolicLink() && rootStat.uid === process.getuid() && (rootStat.mode & 0o077) === 0, "invalid_package", "The skill package directory is not private and owned.");
  const manifestPath = path.join(packageRoot, "manifest.json");
  const manifestStat = await fsp.lstat(manifestPath);
  invariant(manifestStat.isFile() && !manifestStat.isSymbolicLink() && manifestStat.nlink === 1 && manifestStat.uid === process.getuid() && (manifestStat.mode & 0o077) === 0, "invalid_package", "The skill manifest must be a private regular file.");
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  validateManifest(manifest);
  const paths = ["SKILL.md", ...manifest.resources.map((resource) => resource.path)];
  invariant(!paths.some((value) => path.posix.basename(value).toLocaleLowerCase("en-US") === "readme.md"), "invalid_package", "Installed Rico skills cannot contain README files.");
  const files = [];
  for (const relativePath of paths) {
    const clean = validateRelativePath(relativePath);
    await assertPrivateAncestors(packageRoot, clean);
    const target = path.join(packageRoot, clean);
    const stat = await fsp.lstat(target);
    invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, "invalid_package", `Skill resource is not a private regular file: ${clean}`);
    const data = await fsp.readFile(target);
    const validated = validateTextFile({ relativePath: clean, data, mode: stat.mode });
    invariant(scanSecrets(validated.text, clean).length === 0, "secret_detected", "An installed skill resource contains a secret-like value.");
    const resource = manifest.resources.find((candidate) => candidate.path === clean);
    if (resource) {
      invariant(resource.bytes === data.length && resource.sha256 === sha256(validated.text), "package_hash_mismatch", `Skill resource metadata does not match: ${clean}`);
    }
    files.push({ relativePath: clean, text: validated.text });
  }
  const packageFiles = await listCanonicalPackageFiles(packageRoot);
  const expectedFiles = new Set(["manifest.json", ...(allowStageMetadata ? ["stage.json"] : []), ...paths]);
  invariant(packageFiles.length === expectedFiles.size && packageFiles.every((value) => expectedFiles.has(value)), "invalid_package", "The skill package contains unreviewed files.");
  invariant(computePackageHash(manifest, files) === manifest.contentHash, "package_hash_mismatch", "The installed skill package hash does not match its manifest.");
  return { manifest, files };
}

function validateManifest(manifest) {
  invariant(manifest?.schema === RICO_SKILL_SCHEMA && manifest.schemaVersion === 1, "invalid_manifest", "The Rico skill manifest schema is invalid.");
  invariant(typeof manifest.id === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(manifest.id), "invalid_manifest", "The skill identifier is invalid.");
  invariant(typeof manifest.name === "string" && manifest.name.length > 0 && manifest.name.length <= 80 && !/[\u0000-\u001F\u007F]/u.test(manifest.name), "invalid_manifest", "The skill name is invalid.");
  invariant(typeof manifest.description === "string" && manifest.description.length > 0 && manifest.description.length <= 500 && !/[\u0000-\u001F\u007F]/u.test(manifest.description), "invalid_manifest", "The skill description is invalid.");
  invariant(typeof manifest.contentHash === "string" && /^[a-f0-9]{64}$/.test(manifest.contentHash), "invalid_manifest", "The skill content hash is invalid.");
  invariant(manifest.version === `1.0.0+${manifest.contentHash.slice(0, 12)}`, "invalid_manifest", "The skill version does not match its reviewed hash.");
  invariant(manifest.enabledByDefault === false, "invalid_manifest", "Imported skills must be disabled by default.");
  invariant(manifest.audience?.scope === "owner_private" && Object.keys(manifest.audience).length === 1, "invalid_manifest", "Imported skills are limited to Rico's private owner audience.");
  invariant(manifest.policy?.authorizing === false, "invalid_manifest", "Imported skills cannot be authorizing.");
  invariant(Array.isArray(manifest.policy?.effectivePermissions) && manifest.policy.effectivePermissions.length === 0 && NON_AUTHORIZING_POLICY.deniedAuthorities.every((value) => manifest.policy?.deniedAuthorities?.includes(value)), "invalid_manifest", "The skill policy boundary is incomplete.");
  invariant(Array.isArray(manifest.permissions?.effective) && manifest.permissions.effective.length === 0, "invalid_manifest", "Imported skills cannot carry effective permissions.");
  invariant(NON_AUTHORIZING_POLICY.deniedAuthorities.every((value) => manifest.permissions?.denied?.includes(value)), "invalid_manifest", "The skill is missing mandatory denied authorities.");
  invariant(Array.isArray(manifest.permissions?.requested) && manifest.permissions.requested.length <= 20 && manifest.permissions.requested.every((value) => shortString(value)), "invalid_manifest", "The skill permission request inventory is invalid.");
  invariant(Array.isArray(manifest.triggers) && manifest.triggers.length > 0 && manifest.triggers.length <= 10 && manifest.triggers.every((value) => shortString(value, 600)), "invalid_manifest", "The skill trigger inventory is invalid.");
  invariant(Array.isArray(manifest.toolNeeds) && manifest.toolNeeds.length <= 20 && manifest.toolNeeds.every((value) => shortString(value)), "invalid_manifest", "The skill tool-needs inventory is invalid.");
  invariant(Array.isArray(manifest.resources) && manifest.resources.length <= 100, "invalid_manifest", "The skill resource inventory is invalid.");
  const resourcePaths = new Set();
  for (const resource of manifest.resources) {
    const clean = validateRelativePath(resource.path);
    invariant(clean.startsWith("references/") || clean.startsWith("assets/"), "invalid_manifest", "Skill resources must use references/ or assets/ progressive disclosure.");
    invariant(!resourcePaths.has(clean.toLocaleLowerCase("en-US")), "invalid_manifest", "The skill resource inventory contains a duplicate path.");
    resourcePaths.add(clean.toLocaleLowerCase("en-US"));
    invariant(["reference", "asset"].includes(resource.category) && Number.isSafeInteger(resource.bytes) && resource.bytes >= 0 && resource.bytes <= 256 * 1024 && /^[a-f0-9]{64}$/.test(resource.sha256), "invalid_manifest", "Skill resource metadata is invalid.");
    invariant(typeof resource.sourcePath === "string" && resource.sourcePath.length <= 1_000 && validateRelativePath(resource.sourcePath) === resource.sourcePath.normalize("NFC"), "invalid_manifest", "Skill resource provenance is invalid.");
  }
  invariant(["file", "folder", "zip"].includes(manifest.provenance?.sourceKind), "invalid_manifest", "The skill source kind is invalid.");
  invariant(shortString(manifest.provenance?.sourceName, 160) && /^[a-f0-9]{64}$/.test(manifest.provenance?.sourceHash) && manifest.provenance?.transformed === true, "invalid_manifest", "The skill provenance is invalid.");
  invariant(typeof manifest.provenance?.importedAt === "string" && Number.isFinite(Date.parse(manifest.provenance.importedAt)), "invalid_manifest", "The skill import timestamp is invalid.");
}

function shortString(value, maximum = 120) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001F\u007F]/u.test(value);
}

function inventoryRecord(manifest, state, versionID) {
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    versionID,
    contentHash: manifest.contentHash,
    enabled: state.enabled === true,
    audienceScope: manifest.audience.scope,
    triggers: manifest.triggers,
    requestedPermissions: manifest.permissions.requested,
    effectivePermissions: [],
    toolNeeds: manifest.toolNeeds,
    resources: manifest.resources,
    provenance: manifest.provenance,
    history: state.history,
    installedAt: state.installedAt,
    updatedAt: state.updatedAt,
  };
}

function validatedSkillRoot(libraryRoot, skillID) {
  invariant(typeof skillID === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(skillID), "invalid_skill", "The skill identifier is invalid.");
  return path.join(path.resolve(libraryRoot), "installed", skillID);
}

function validatedVersionRoot(skillRoot, versionID) {
  invariant(typeof versionID === "string" && /^[A-Za-z0-9.+-]{1,120}$/.test(versionID), "invalid_version", "The skill version identifier is invalid.");
  const versionsRoot = path.join(skillRoot, "versions");
  const target = path.resolve(versionsRoot, versionID);
  invariant(target.startsWith(`${path.resolve(versionsRoot)}${path.sep}`), "invalid_version", "The skill version path is invalid.");
  return target;
}

async function readState(skillRoot) {
  try {
    const statePath = path.join(skillRoot, "state.json");
    const stat = await fsp.lstat(statePath);
    invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, "invalid_state", "The skill state file is not private and owned.");
    const state = JSON.parse(await fsp.readFile(statePath, "utf8"));
    invariant(state.schema === RICO_SKILL_STATE_SCHEMA && state.schemaVersion === 1, "invalid_state", "The skill state schema is invalid.");
    return state;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function markStageInstalled(stagePath, stage, versionID) {
  const next = { ...stage, reviewToken: undefined, status: "installed", installedVersion: versionID, installedAt: new Date().toISOString() };
  await atomicWriteJSON(path.join(stagePath, "stage.json"), next);
}

async function writePrivateFile(root, relativePath, text) {
  const target = path.join(root, validateRelativePath(relativePath));
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fsp.chmod(path.dirname(target), 0o700);
  await fsp.writeFile(target, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

async function atomicWriteJSON(target, value) {
  const parent = path.dirname(target);
  await ensurePrivateDirectory(parent);
  const temporary = path.join(parent, `.state-${cryptoRandomID()}.tmp`);
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fsp.rename(temporary, target);
  await fsp.chmod(target, 0o600);
}

async function removeIncoming(target, versionsRoot) {
  const resolved = path.resolve(target);
  const prefix = `${path.resolve(versionsRoot)}${path.sep}.incoming-`;
  if (!resolved.startsWith(prefix)) return;
  try { await fsp.rm(resolved, { recursive: true, force: false }); } catch { /* best effort for a private failed install only */ }
}

async function exists(target) {
  try { await fsp.access(target); return true; } catch { return false; }
}

function cryptoRandomID() {
  return globalThis.crypto.randomUUID();
}

async function assertPrivateDirectory(directory, message) {
  const stat = await fsp.lstat(directory);
  invariant(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, "unsafe_store", message);
}

async function assertPrivateAncestors(root, relativePath) {
  const components = relativePath.split("/").slice(0, -1);
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    await assertPrivateDirectory(current, `Skill resource parent is not private and owned: ${relativePath}`);
  }
}

async function listCanonicalPackageFiles(root) {
  const files = [];
  async function visit(directory, relativeDirectory = "") {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      validateRelativePath(relativePath);
      const target = path.join(directory, entry.name);
      const stat = await fsp.lstat(target);
      invariant(!stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, "invalid_package", `The skill package contains an unsafe entry: ${relativePath}`);
      if (stat.isDirectory()) await visit(target, relativePath);
      else {
        invariant(stat.isFile() && stat.nlink === 1, "invalid_package", `The skill package contains a special entry: ${relativePath}`);
        files.push(relativePath);
      }
    }
  }
  await visit(root);
  return files.sort();
}

function assertVersionIdentity(versionID, manifest) {
  invariant(versionID === `${manifest.version}-${manifest.contentHash.slice(0, 12)}`, "invalid_version", "The selected version directory does not match its manifest.");
}
