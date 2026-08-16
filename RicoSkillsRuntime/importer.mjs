import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { collectSourceFiles, ensurePrivateDirectory } from "./archive.mjs";
import { canonicalizeSkill, sha256, stableStringify } from "./canonical.mjs";
import { RICO_SKILL_STAGE_SCHEMA } from "./constants.mjs";
import { invariant } from "./errors.mjs";

export async function stageSkillImport({ sourcePath, libraryRoot, now = new Date() }) {
  const root = path.resolve(libraryRoot);
  const quarantineRoot = path.join(root, "quarantine");
  await ensurePrivateDirectory(root);
  await ensurePrivateDirectory(quarantineRoot);
  const sourceStat = await fsp.lstat(path.resolve(sourcePath));
  invariant(!sourceStat.isSymbolicLink(), "symlink", "Symbolic links cannot be imported.");
  const sourceKind = sourceStat.isDirectory() ? "folder" : path.extname(sourcePath).toLowerCase() === ".zip" ? "zip" : "file";
  const files = await collectSourceFiles(sourcePath, quarantineRoot);
  const canonical = canonicalizeSkill(files, {
    sourceName: path.basename(sourcePath),
    sourceKind,
    importedAt: now.toISOString(),
  });
  const reviewToken = crypto.randomBytes(24).toString("hex");
  const stageID = crypto.randomUUID();
  const incoming = path.join(quarantineRoot, `.incoming-${stageID}`);
  const finalPath = path.join(quarantineRoot, stageID);
  await ensurePrivateDirectory(incoming);
  try {
    for (const file of canonical.files) await writePrivateFile(incoming, file.relativePath, file.text);
    await writePrivateFile(incoming, "manifest.json", `${JSON.stringify(canonical.manifest, null, 2)}\n`);
    const stage = {
      schema: RICO_SKILL_STAGE_SCHEMA,
      schemaVersion: 1,
      stageID,
      reviewToken,
      stagedAt: now.toISOString(),
      status: "awaiting_review",
      review: canonical.review,
      reviewHash: sha256(stableStringify(canonical.review)),
    };
    await writePrivateFile(incoming, "stage.json", `${JSON.stringify(stage, null, 2)}\n`);
    await fsp.rename(incoming, finalPath);
    return { ...stage, stagePath: finalPath };
  } catch (error) {
    await removeIncoming(incoming, quarantineRoot);
    throw error;
  }
}

export async function listStagedImports(libraryRoot) {
  const quarantineRoot = path.join(path.resolve(libraryRoot), "quarantine");
  try { await ensurePrivateDirectory(quarantineRoot); }
  catch { return []; }
  const entries = await fsp.readdir(quarantineRoot, { withFileTypes: true });
  const stages = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const stagePath = path.join(quarantineRoot, entry.name);
    try {
      const stat = await fsp.lstat(stagePath);
      if (stat.isSymbolicLink() || stat.uid !== process.getuid()) continue;
      const stage = JSON.parse(await fsp.readFile(path.join(stagePath, "stage.json"), "utf8"));
      if (stage.schema !== RICO_SKILL_STAGE_SCHEMA || stage.status !== "awaiting_review" || stage.stageID !== entry.name || stage.reviewHash !== sha256(stableStringify(stage.review))) continue;
      stages.push({ ...stage, reviewToken: undefined, stagePath });
    } catch { /* Ignore corrupt quarantine entries; they cannot be installed. */ }
  }
  return stages.sort((a, b) => b.stagedAt.localeCompare(a.stagedAt));
}

export async function loadStageForReview(stagePath, libraryRoot) {
  await ensurePrivateDirectory(path.resolve(libraryRoot));
  await ensurePrivateDirectory(path.join(path.resolve(libraryRoot), "quarantine"));
  const resolved = validateStagePath(stagePath, libraryRoot);
  const stage = JSON.parse(await fsp.readFile(path.join(resolved, "stage.json"), "utf8"));
  invariant(stage.schema === RICO_SKILL_STAGE_SCHEMA && stage.status === "awaiting_review", "invalid_stage", "This staged import is not reviewable.");
  invariant(stage.reviewHash === sha256(stableStringify(stage.review)), "review_mismatch", "The staged review changed after quarantine.");
  return { ...stage, stagePath: resolved };
}

export function validateStagePath(stagePath, libraryRoot) {
  const quarantine = `${path.resolve(libraryRoot, "quarantine")}${path.sep}`;
  const resolved = path.resolve(stagePath);
  invariant(resolved.startsWith(quarantine) && !path.basename(resolved).startsWith("."), "invalid_stage", "The staged import is outside Rico's private quarantine.");
  return resolved;
}

async function writePrivateFile(root, relativePath, text) {
  const target = path.join(root, relativePath);
  const parent = path.dirname(target);
  await fsp.mkdir(parent, { recursive: true, mode: 0o700 });
  await fsp.chmod(parent, 0o700);
  await fsp.writeFile(target, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

async function removeIncoming(target, quarantineRoot) {
  const resolved = path.resolve(target);
  const prefix = `${path.resolve(quarantineRoot)}${path.sep}.incoming-`;
  if (!resolved.startsWith(prefix)) return;
  try { await fsp.rm(resolved, { recursive: true, force: false }); } catch { /* best effort for private failed staging only */ }
}
