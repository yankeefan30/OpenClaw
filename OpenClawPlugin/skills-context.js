import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const bundledRuntime = new URL("./RicoSkillsRuntime/index.mjs", import.meta.url);
const sourceRuntime = new URL("../RicoSkillsRuntime/index.mjs", import.meta.url);
const runtimeURL = fs.existsSync(fileURLToPath(bundledRuntime)) ? bundledRuntime : sourceRuntime;
let runtimePromise;

function loadRuntime() {
  runtimePromise ??= import(runtimeURL.href);
  return runtimePromise;
}

export const RICO_SKILLS_CONTEXT_MAX_CHARACTERS = 40_000;

export function isExactOwnerPrivateSkillsAudience(senderContext) {
  return senderContext?.isOwner === true &&
    senderContext?.conversationType === "direct" &&
    typeof senderContext?.senderHandle === "string" &&
    senderContext.senderHandle.length > 0;
}

export function validateOwnerPrivateSkillsContext(compiled, expectedBoundary) {
  if (!compiled || compiled.audienceScope !== "owner_private" ||
      compiled.boundary !== expectedBoundary || typeof compiled.text !== "string" ||
      compiled.text.length > RICO_SKILLS_CONTEXT_MAX_CHARACTERS + expectedBoundary.length + 2_000 ||
      !Array.isArray(compiled.skillIDs) || compiled.skillIDs.length === 0 || compiled.skillIDs.length > 32 ||
      new Set(compiled.skillIDs).size !== compiled.skillIDs.length ||
      !compiled.skillIDs.every((value) => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/u.test(value)) ||
      !compiled.text.startsWith(`${expectedBoundary}\n\n`) ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(compiled.text)) return "";
  for (const skillID of compiled.skillIDs) {
    const opening = `<rico-imported-skill id="${skillID}" `;
    if (compiled.text.split(opening).length !== 2) return "";
  }
  const openings = compiled.text.match(/<rico-imported-skill\b/gu)?.length ?? 0;
  const closings = compiled.text.match(/<\/rico-imported-skill>/gu)?.length ?? 0;
  if (openings !== compiled.skillIDs.length || closings !== openings) return "";
  return compiled.text;
}

/**
 * Read-only prompt seam for an authenticated owner/direct iMessage run.
 * Invalid, unreviewed, disabled, non-private, or hash-mismatched packages are
 * omitted. Imported instructions remain context only; tool authority stays in
 * the existing recipient guard and OpenClaw tool policies.
 */
export async function ownerPrivateSkillsSystemContext({
  senderContext,
  supportDirectory,
  runtimeLoader = loadRuntime,
} = {}) {
  if (!isExactOwnerPrivateSkillsAudience(senderContext) || typeof supportDirectory !== "string" || !supportDirectory) return "";
  try {
    const runtime = await runtimeLoader();
    if (typeof runtime?.compileEnabledSkillsContext !== "function" || typeof runtime?.CONTEXT_BOUNDARY !== "string") return "";
    const compiled = await runtime.compileEnabledSkillsContext(
      path.join(supportDirectory, "Rico Skills"),
      { maxCharacters: RICO_SKILLS_CONTEXT_MAX_CHARACTERS, audienceScope: "owner_private" },
    );
    return validateOwnerPrivateSkillsContext(compiled, runtime.CONTEXT_BOUNDARY);
  } catch {
    return "";
  }
}
