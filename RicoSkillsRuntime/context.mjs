import fsp from "node:fs/promises";
import path from "node:path";
import { CONTEXT_BOUNDARY } from "./constants.mjs";
import { listInstalledSkills, verifyCanonicalPackage } from "./store.mjs";

export async function compileEnabledSkillsContext(libraryRoot, { maxCharacters = 40_000, audienceScope = "owner_private" } = {}) {
  if (audienceScope !== "owner_private") return { boundary: CONTEXT_BOUNDARY, audienceScope, skillIDs: [], text: "" };
  const installed = await listInstalledSkills(libraryRoot);
  const enabled = installed.filter((skill) => skill.enabled && skill.audienceScope === "owner_private").slice(0, 32);
  const sections = [];
  let characters = CONTEXT_BOUNDARY.length;
  for (const skill of enabled) {
    const packageRoot = path.join(path.resolve(libraryRoot), "installed", skill.id, "versions", skill.versionID);
    const verified = await verifyCanonicalPackage(packageRoot);
    const markdown = await fsp.readFile(path.join(packageRoot, "SKILL.md"), "utf8");
    if (characters + markdown.length > maxCharacters) break;
    const escaped = markdown.trim().replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    sections.push(`<rico-imported-skill id="${skill.id}" hash="${skill.contentHash}" audience="owner_private">\n${escaped}\n</rico-imported-skill>`);
    characters += markdown.length;
  }
  return {
    boundary: CONTEXT_BOUNDARY,
    audienceScope,
    skillIDs: enabled.slice(0, sections.length).map((skill) => skill.id),
    text: sections.length === 0 ? "" : `${CONTEXT_BOUNDARY}\n\n${sections.join("\n\n")}`,
  };
}
