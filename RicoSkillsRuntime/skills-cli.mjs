#!/usr/bin/env node
import {
  installReviewedSkill,
  listInstalledSkills,
  listStagedImports,
  loadStageForReview,
  rollbackSkill,
  setSkillEnabled,
  stageSkillImport,
} from "./index.mjs";
import { RicoSkillError } from "./errors.mjs";

async function main(argv) {
  let command;
  let options;
  if (argv[0] === "--json-stdin") {
    const input = JSON.parse(await readStandardInput());
    command = input.command;
    options = input.options ?? {};
  } else {
    [command, ...argv] = argv;
    options = parseOptions(argv);
  }
  const libraryRoot = required(options, "root");
  switch (command) {
  case "inventory":
    return {
      schema: "openclaw.rico-skill-library/v1",
      installed: await listInstalledSkills(libraryRoot),
      staged: await listStagedImports(libraryRoot),
    };
  case "stage":
    return stageSkillImport({ sourcePath: required(options, "source"), libraryRoot });
  case "review":
    return loadStageForReview(required(options, "stage"), libraryRoot);
  case "install":
    return installReviewedSkill({
      stagePath: required(options, "stage"),
      libraryRoot,
      approval: {
        approved: options.approve === "true",
        reviewToken: required(options, "token"),
        contentHash: required(options, "hash"),
      },
    });
  case "enable":
    return setSkillEnabled({
      libraryRoot,
      skillID: required(options, "skill"),
      enabled: options.enabled === "true",
      approval: {
        approved: options.approve === "true",
        acknowledgeNonAuthorizing: options["acknowledge-non-authorizing"] === "true",
        contentHash: options.hash,
      },
    });
  case "rollback":
    return rollbackSkill({
      libraryRoot,
      skillID: required(options, "skill"),
      versionID: required(options, "version"),
      approval: { approved: options.approve === "true", contentHash: required(options, "hash") },
    });
  default:
    throw new RicoSkillError("usage", "Use inventory, stage, review, install, enable, or rollback.");
  }
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const value = Buffer.concat(chunks).toString("utf8");
  if (value.length === 0 || value.length > 256 * 1024) throw new RicoSkillError("usage", "The JSON request is empty or too large.");
  return value;
}

function parseOptions(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key.startsWith("--")) throw new RicoSkillError("usage", `Unexpected argument: ${key}`);
    const value = values[index + 1];
    if (value === undefined || value.startsWith("--")) throw new RicoSkillError("usage", `Missing value for ${key}.`);
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}

function required(options, key) {
  const value = options[key];
  if (typeof value !== "string" || value.length === 0) throw new RicoSkillError("usage", `Missing --${key}.`);
  return value;
}

try {
  const result = await main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
  const safe = error instanceof RicoSkillError ? error.toJSON() : { code: "internal_error", message: "The Rico skills operation failed." };
  process.stdout.write(`${JSON.stringify({ ok: false, error: safe })}\n`);
  process.exitCode = 1;
}
