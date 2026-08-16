import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import {
  CURRENT_STATUS_REQUEST_CONTRACT,
  normalizeCurrentStatusResultContract,
} from "./result-contract.js";

export const DEFAULT_HANDOFF_DIRECTORY = "/Users/alan/Documents/Codex/rico-escalate";
export const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_APPEND_BYTES = 16 * 1024;
export const DEFAULT_WAIT_MS = 35 * 60 * 1000;
export const FAST_POLL_WINDOW_MS = 30 * 1000;
export const FAST_POLL_INTERVAL_MS = 2 * 1000;
export const SLOW_POLL_INTERVAL_MS = 5 * 1000;
export const REQUEST_ID_PATTERN = /^rico_[0-9]{8}T[0-9]{9}Z_[a-f0-9]{32}$/u;

const FILES = Object.freeze({ inbox: "INBOX.md", outbox: "OUTBOX.md" });
const ALLOWED_AUDIENCES = new Set([
  "owner_private",
  "approved_direct",
  "approved_group",
  "authorized_any_local_group",
]);
const ALLOWED_CONFIDENCE = new Set(["high", "medium", "low"]);
const MAX_QUESTION_CHARS = 4000;
const MAX_TRIED_ITEMS = 6;
const MAX_TRIED_CHARS = 500;
const MAX_DONE_CHARS = 1200;
const MAX_ANSWER_CHARS = 10_000;
const MAX_EVIDENCE_ITEMS = 12;
const MAX_EVIDENCE_CHARS = 1000;
const MAX_LIMIT_ITEMS = 8;
const MAX_LIMIT_CHARS = 800;
const SUBMISSION_LOCK_NAME = ".submit-with-id.lock";
const SUBMISSION_LOCK_MAX_BYTES = 1024;
const SUBMISSION_LOCK_WAIT_MS = 5_000;
const SUBMISSION_LOCK_RETRY_MS = 10;
const SUBMISSION_LOCK_STALE_MS = 5 * 60 * 1000;
const submissionQueues = new Map();

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeText(value, { max, multiline = true, code = "handoff_text_invalid" } = {}) {
  const text = String(value ?? "").normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  const controls = multiline
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u
    : /[\u0000-\u001f\u007f-\u009f]/u;
  if (!text || (Number.isInteger(max) && text.length > max) || controls.test(text)) throw coded(code);
  return text;
}

function sensitiveTransforms(text) {
  const kinds = new Set();
  let output = text;
  const replace = (pattern, replacement, kind) => {
    output = output.replace(pattern, (...args) => {
      kinds.add(kind);
      return typeof replacement === "function" ? replacement(...args) : replacement;
    });
  };

  replace(
    /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----/gu,
    "[REDACTED_CREDENTIAL]",
    "credential",
  );
  replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/giu, "Bearer [REDACTED]", "credential");
  replace(/\b(?:sk|xox[baprs]|gh[pousr])[-_][A-Za-z0-9_-]{12,}\b/gu, "[REDACTED_CREDENTIAL]", "credential");
  replace(/\bglpat-[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED_CREDENTIAL]", "credential");
  replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, "[REDACTED_CREDENTIAL]", "credential");
  replace(/\bAIza[A-Za-z0-9_-]{35}\b/gu, "[REDACTED_CREDENTIAL]", "credential");
  replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED_CREDENTIAL]", "credential");
  replace(
    /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_-]{6,}\/[A-Za-z0-9_-]{6,}\/[A-Za-z0-9_-]{12,}/giu,
    "[REDACTED_CREDENTIAL]",
    "credential",
  );
  replace(
    /\b(api[ _-]?key|access[ _-]?token|refresh[ _-]?token|password|secret)\b(\s*[:=]\s*)([^\s,;]{4,})/giu,
    (_whole, label, separator) => `${label}${separator}[REDACTED]`,
    "credential",
  );
  replace(/\+\d(?:[\s().-]*\d){7,14}(?!\d)/gu, "[REDACTED_PHONE]", "phone");
  replace(
    /(?<![\p{L}\p{N}])(?:\(\d{3}\)|\d{3})[ .-]*\d{3}[ .-]*\d{4}(?![\p{L}\p{N}])/gu,
    "[REDACTED_PHONE]",
    "phone",
  );
  return Object.freeze({ text: output, kinds: Object.freeze([...kinds].sort()) });
}

export function redactForHandoff(value, options) {
  const source = normalizeText(value, options);
  return sensitiveTransforms(source);
}

function assertNoSensitiveResult(value) {
  const source = normalizeText(value, { max: Math.max(MAX_ANSWER_CHARS, MAX_EVIDENCE_CHARS), code: "outbox_text_invalid" });
  const transformed = sensitiveTransforms(source);
  if (transformed.kinds.length > 0) throw coded("outbox_sensitive_content");
  if (/(?:^|\n)\s*(?:system|developer|assistant)\s*:/iu.test(source) ||
      /<\|(?:im_start|im_end|system|assistant|developer)/iu.test(source) ||
      /\bignore\s+(?:all\s+)?(?:prior|previous)\s+instructions\b/iu.test(source)) {
    throw coded("outbox_instruction_injection");
  }
  return source;
}

function quoteMarkdown(text) {
  return text.split("\n").map((line) => line ? `> ${line}` : ">").join("\n");
}

function bulletMarkdown(text) {
  return text.replace(/\s*\n\s*/gu, " / ");
}

function generateRequestId(now, randomBytes) {
  const stamp = now.toISOString().replace(/[-:.]/gu, "");
  const entropy = Buffer.from(randomBytes(16));
  if (entropy.byteLength !== 16) throw coded("request_id_entropy_invalid");
  const id = `rico_${stamp}_${entropy.toString("hex")}`;
  if (!REQUEST_ID_PATTERN.test(id)) throw coded("request_id_generation_failed");
  return id;
}

function exactRequestId(value) {
  const id = String(value ?? "").trim();
  if (!REQUEST_ID_PATTERN.test(id)) throw coded("request_id_invalid");
  return id;
}

function exactAudienceScope(value) {
  const scope = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(scope)) throw coded("handoff_audience_scope_invalid");
  return scope;
}

function mode(stat) {
  return stat.mode & 0o777;
}

function assertOwnedByCurrentUser(stat) {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw coded("handoff_owner_mismatch");
  }
}

async function assertPrivateDirectory(baseDirectory, allowTestDirectory) {
  const resolved = path.resolve(baseDirectory);
  if (!path.isAbsolute(baseDirectory) || resolved !== baseDirectory ||
      (resolved !== DEFAULT_HANDOFF_DIRECTORY && allowTestDirectory !== true)) {
    throw coded("handoff_directory_invalid");
  }
  const stat = await fs.promises.lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw coded("handoff_directory_not_private_directory");
  assertOwnedByCurrentUser(stat);
  if (mode(stat) !== 0o700) throw coded("handoff_directory_mode_invalid");
  if (await fs.promises.realpath(resolved) !== resolved) throw coded("handoff_directory_realpath_mismatch");
  return resolved;
}

function assertPrivateFileStat(stat) {
  if (stat.isSymbolicLink() || !stat.isFile()) throw coded("handoff_file_not_regular");
  if (stat.nlink !== 1) throw coded("handoff_file_link_count_invalid");
  assertOwnedByCurrentUser(stat);
  if (mode(stat) !== 0o600) throw coded("handoff_file_mode_invalid");
}

async function openPrivateFile(baseDirectory, kind, flags, maxFileBytes, allowTestDirectory) {
  const directory = await assertPrivateDirectory(baseDirectory, allowTestDirectory);
  const fileName = FILES[kind];
  if (!fileName) throw coded("handoff_file_kind_invalid");
  const filePath = path.join(directory, fileName);
  if (path.dirname(filePath) !== directory) throw coded("handoff_path_escape");
  const before = await fs.promises.lstat(filePath);
  assertPrivateFileStat(before);
  if (before.size > maxFileBytes) throw coded("handoff_file_too_large");
  if (await fs.promises.realpath(filePath) !== filePath) throw coded("handoff_file_realpath_mismatch");
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const closeOnExec = fs.constants.O_CLOEXEC ?? 0;
  const handle = await fs.promises.open(filePath, flags | noFollow | closeOnExec);
  try {
    const after = await handle.stat();
    assertPrivateFileStat(after);
    if (after.dev !== before.dev || after.ino !== before.ino) throw coded("handoff_file_changed_during_open");
    if (after.size > maxFileBytes) throw coded("handoff_file_too_large");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readPrivateFile(baseDirectory, kind, maxFileBytes, allowTestDirectory) {
  const handle = await openPrivateFile(baseDirectory, kind, fs.constants.O_RDONLY, maxFileBytes, allowTestDirectory);
  try {
    const before = await handle.stat();
    assertPrivateFileStat(before);
    const content = await handle.readFile();
    if (content.byteLength > maxFileBytes) throw coded("handoff_file_too_large");
    const after = await handle.stat();
    assertPrivateFileStat(after);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        content.byteLength !== before.size) {
      throw coded("handoff_file_changed_during_read");
    }
    return content.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function appendPrivateFile(baseDirectory, kind, content, maxFileBytes, allowTestDirectory) {
  const payload = Buffer.from(content, "utf8");
  if (payload.byteLength < 1 || payload.byteLength > MAX_APPEND_BYTES) throw coded("handoff_append_too_large");
  const handle = await openPrivateFile(
    baseDirectory,
    kind,
    fs.constants.O_WRONLY | fs.constants.O_APPEND,
    maxFileBytes,
    allowTestDirectory,
  );
  try {
    const before = await handle.stat();
    if (before.size + payload.byteLength > maxFileBytes) throw coded("handoff_file_too_large");
    const { bytesWritten } = await handle.write(payload);
    if (bytesWritten !== payload.byteLength) throw coded("handoff_append_incomplete");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function recordSections(markdown) {
  const matches = [...markdown.matchAll(/^## ([A-Za-z0-9][A-Za-z0-9._:-]{0,127})[ \t]*$/gmu)];
  return matches.map((match, index) => ({
    id: match[1],
    body: markdown.slice(match.index + match[0].length, matches[index + 1]?.index ?? markdown.length),
  }));
}

function exactSection(markdown, requestId, missingCode) {
  const matches = recordSections(markdown).filter((section) => section.id === requestId);
  if (matches.length === 0) throw coded(missingCode);
  if (matches.length !== 1) throw coded("handoff_request_ambiguous");
  return matches[0].body;
}

function exactField(body, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const matches = [...body.matchAll(new RegExp(`^- ${escaped}: (.+)$`, "gmu"))];
  if (matches.length !== 1) throw coded("outbox_metadata_invalid");
  return matches[0][1].trim();
}

function optionalExactField(body, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const matches = [...body.matchAll(new RegExp(`^- ${escaped}: (.+)$`, "gmu"))];
  if (matches.length > 1) throw coded("outbox_metadata_invalid");
  return matches[0]?.[1].trim();
}

function between(body, start, end) {
  const startMarker = `### ${start}`;
  const startIndex = body.indexOf(startMarker);
  if (startIndex < 0 || body.indexOf(startMarker, startIndex + startMarker.length) >= 0) {
    throw coded("outbox_sections_invalid");
  }
  const contentStart = startIndex + startMarker.length;
  const endIndex = end ? body.indexOf(`### ${end}`, contentStart) : body.length;
  if (end && (endIndex < 0 || body.indexOf(`### ${end}`, endIndex + end.length + 4) >= 0)) {
    throw coded("outbox_sections_invalid");
  }
  return body.slice(contentStart, endIndex).trim();
}

function unquote(text) {
  const lines = text.split("\n");
  if (lines.every((line) => !line || /^> ?/u.test(line))) {
    return lines.map((line) => line.replace(/^> ?/u, "")).join("\n").trim();
  }
  return text.trim();
}

function bulletItems(text, maxItems, maxChars, code) {
  const lines = text.split("\n").filter((line) => line.trim());
  if (lines.length < 1 || lines.length > maxItems || lines.some((line) => !/^-[ \t]+/u.test(line))) throw coded(code);
  return lines.map((line) => assertNoSensitiveResult(normalizeText(line.replace(/^-[ \t]+/u, ""), { max: maxChars, multiline: false, code })));
}

function parseInboxRequest(markdown, requestId) {
  const body = exactSection(markdown, requestId, "inbox_request_not_found");
  if (exactField(body, "status") !== "open") throw coded("inbox_status_invalid");
  const audience = exactField(body, "audience");
  if (!ALLOWED_AUDIENCES.has(audience)) throw coded("inbox_audience_invalid");
  const audienceScope = exactAudienceScope(exactField(body, "audience_scope_sha256"));
  const createdAt = exactField(body, "created_at_utc");
  if (!Number.isFinite(Date.parse(createdAt))) throw coded("inbox_timestamp_invalid");
  const resultContractValue = optionalExactField(body, "result_contract");
  const resultContract = resultContractValue === undefined ? null : resultContractValue;
  if (resultContract !== null && resultContract !== CURRENT_STATUS_REQUEST_CONTRACT) {
    throw coded("inbox_result_contract_invalid");
  }
  const privacy = exactField(body, "privacy");
  const question = normalizeText(unquote(between(body, "Question", "Already tried")), {
    max: MAX_QUESTION_CHARS,
    code: "inbox_question_invalid",
  });
  const alreadyTried = bulletItems(
    between(body, "Already tried", "Done looks like"),
    MAX_TRIED_ITEMS,
    MAX_TRIED_CHARS,
    "inbox_already_tried_invalid",
  );
  const doneLooksLike = normalizeText(unquote(between(body, "Done looks like")), {
    max: MAX_DONE_CHARS,
    code: "inbox_done_invalid",
  });
  return Object.freeze({
    audience,
    audienceScope,
    createdAt,
    privacy,
    question,
    alreadyTried: Object.freeze(alreadyTried),
    doneLooksLike,
    resultContract,
  });
}

function parsePublicCitations(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw coded("outbox_result_contract_invalid");
  }
}

function parseOutboxResultContract(body, answer, confidence, required) {
  const raw = {
    resultContractVersion: optionalExactField(body, "result_contract_version"),
    observedAt: optionalExactField(body, "observed_at_utc"),
    sourceClass: optionalExactField(body, "source_class"),
    publicCitations: optionalExactField(body, "public_citations_json"),
  };
  const present = Object.values(raw).filter((value) => value !== undefined).length;
  if (present === 0) return normalizeCurrentStatusResultContract({ answer }, { required });
  if (present !== 4 || raw.resultContractVersion !== String(1)) throw coded("outbox_result_contract_invalid");
  return normalizeCurrentStatusResultContract({
    answer,
    confidence,
    resultContractVersion: Number(raw.resultContractVersion),
    observedAt: raw.observedAt === "none" ? null : raw.observedAt,
    sourceClass: raw.sourceClass,
    publicCitations: parsePublicCitations(raw.publicCitations),
  }, { required });
}

function parseOutboxResult(markdown, requestId, inbox) {
  const body = exactSection(markdown, requestId, "outbox_result_pending");
  if (exactField(body, "status") !== "complete") throw coded("outbox_status_invalid");
  const completedAt = exactField(body, "completed_at_utc");
  const completedMs = Date.parse(completedAt);
  if (!Number.isFinite(completedMs) || completedMs < Date.parse(inbox.createdAt)) throw coded("outbox_timestamp_invalid");
  const confidence = exactField(body, "confidence");
  if (!ALLOWED_CONFIDENCE.has(confidence)) throw coded("outbox_confidence_invalid");
  const answer = assertNoSensitiveResult(normalizeText(unquote(between(body, "Answer", "Evidence")), {
    max: MAX_ANSWER_CHARS,
    code: "outbox_answer_invalid",
  }));
  const evidence = bulletItems(
    between(body, "Evidence", "Unresolved limits"),
    MAX_EVIDENCE_ITEMS,
    MAX_EVIDENCE_CHARS,
    "outbox_evidence_invalid",
  );
  const unresolvedLimits = bulletItems(
    between(body, "Unresolved limits"),
    MAX_LIMIT_ITEMS,
    MAX_LIMIT_CHARS,
    "outbox_limits_invalid",
  );
  const resultContract = parseOutboxResultContract(
    body,
    answer,
    confidence,
    inbox.resultContract === CURRENT_STATUS_REQUEST_CONTRACT,
  );
  return Object.freeze({
    requestId,
    audience: inbox.audience,
    completedAt,
    confidence,
    answer,
    evidence: Object.freeze(evidence),
    unresolvedLimits: Object.freeze(unresolvedLimits),
    ...(resultContract ?? {}),
  });
}

function exactRequestContract(value) {
  if (value === undefined || value === null || value === "") return null;
  const contract = String(value).trim();
  if (contract !== CURRENT_STATUS_REQUEST_CONTRACT) throw coded("handoff_result_contract_invalid");
  return contract;
}

function prepareSubmission({ question, audience, audienceScope, alreadyTried, doneLooksLike, resultContract }) {
  if (!ALLOWED_AUDIENCES.has(audience)) throw coded("handoff_audience_invalid");
  const exactScope = exactAudienceScope(audienceScope);
  if (!Array.isArray(alreadyTried) || alreadyTried.length < 1 || alreadyTried.length > MAX_TRIED_ITEMS) {
    throw coded("handoff_already_tried_invalid");
  }
  const sanitizedQuestion = redactForHandoff(question, { max: MAX_QUESTION_CHARS, code: "handoff_question_invalid" });
  const sanitizedTried = alreadyTried.map((item) => redactForHandoff(item, {
    max: MAX_TRIED_CHARS,
    code: "handoff_already_tried_invalid",
  }));
  const sanitizedDone = redactForHandoff(doneLooksLike, { max: MAX_DONE_CHARS, code: "handoff_done_invalid" });
  const redactions = new Set([
    ...sanitizedQuestion.kinds,
    ...sanitizedTried.flatMap((item) => item.kinds),
    ...sanitizedDone.kinds,
  ]);
  const privacy = [
    "minimum visible question and same-audience context only",
    "no sender identifier or hidden context exported",
    redactions.size ? `redacted: ${[...redactions].sort().join(", ")}` : "redacted: none",
  ].join("; ");
  return Object.freeze({
    audience,
    audienceScope: exactScope,
    question: sanitizedQuestion.text,
    alreadyTried: Object.freeze(sanitizedTried.map((item) => item.text)),
    doneLooksLike: sanitizedDone.text,
    privacy,
    redactions: Object.freeze([...redactions].sort()),
    resultContract: exactRequestContract(resultContract),
  });
}

function submissionRecord(requestId, now, prepared) {
  return [
    "",
    `## ${requestId}`,
    `- created_at_utc: ${now.toISOString()}`,
    "- status: open",
    `- audience: ${prepared.audience}`,
    `- audience_scope_sha256: ${prepared.audienceScope}`,
    `- privacy: ${prepared.privacy}`,
    ...(prepared.resultContract ? [`- result_contract: ${prepared.resultContract}`] : []),
    "",
    "### Question",
    quoteMarkdown(prepared.question),
    "",
    "### Already tried",
    ...prepared.alreadyTried.map((item) => `- ${bulletMarkdown(item)}`),
    "",
    "### Done looks like",
    quoteMarkdown(prepared.doneLooksLike),
    "",
  ].join("\n");
}

function submissionMatches(existing, prepared) {
  return existing.audience === prepared.audience &&
    existing.audienceScope === prepared.audienceScope &&
    existing.privacy === prepared.privacy &&
    existing.question === prepared.question &&
    existing.doneLooksLike === prepared.doneLooksLike &&
    existing.resultContract === prepared.resultContract &&
    existing.alreadyTried.length === prepared.alreadyTried.length &&
    existing.alreadyTried.every((item, index) => item === prepared.alreadyTried[index]);
}

async function serializeSubmission(baseDirectory, operation) {
  const prior = submissionQueues.get(baseDirectory) ?? Promise.resolve();
  const current = prior.catch(() => {}).then(operation);
  submissionQueues.set(baseDirectory, current);
  try {
    return await current;
  } finally {
    if (submissionQueues.get(baseDirectory) === current) submissionQueues.delete(baseDirectory);
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    return null;
  }
}

async function inspectSubmissionLock(lockPath) {
  const before = await fs.promises.lstat(lockPath);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) throw coded("handoff_submit_lock_invalid");
  assertOwnedByCurrentUser(before);
  if (mode(before) !== 0o600 || before.size > SUBMISSION_LOCK_MAX_BYTES ||
      await fs.promises.realpath(lockPath) !== lockPath) {
    throw coded("handoff_submit_lock_invalid");
  }
  if (before.size === 0) return Object.freeze({ stat: before, pid: null, initializing: true });
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_CLOEXEC ?? 0);
  const handle = await fs.promises.open(lockPath, flags);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino ||
        mode(opened) !== 0o600 || opened.size > SUBMISSION_LOCK_MAX_BYTES) {
      throw coded("handoff_submit_lock_changed");
    }
    assertOwnedByCurrentUser(opened);
    const payload = await handle.readFile();
    const after = await handle.stat();
    const current = await fs.promises.lstat(lockPath);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
        current.dev !== opened.dev || current.ino !== opened.ino || current.size !== opened.size ||
        payload.byteLength !== opened.size) {
      throw coded("handoff_submit_lock_changed");
    }
    let value;
    try {
      value = JSON.parse(payload.toString("utf8"));
    } catch {
      return Object.freeze({ stat: current, pid: null, initializing: true });
    }
    return Object.freeze({
      stat: current,
      pid: Number(value?.pid),
      createdAt: String(value?.created_at_utc ?? ""),
      initializing: false,
    });
  } finally {
    await handle.close();
  }
}

async function removeExactSubmissionLock(lockPath, expected) {
  const current = await fs.promises.lstat(lockPath);
  if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1 ||
      current.dev !== expected.dev || current.ino !== expected.ino || mode(current) !== 0o600) {
    throw coded("handoff_submit_lock_changed");
  }
  assertOwnedByCurrentUser(current);
  if (await fs.promises.realpath(lockPath) !== lockPath) throw coded("handoff_submit_lock_changed");
  await fs.promises.unlink(lockPath);
}

async function acquireSubmissionLock(baseDirectory, allowTestDirectory) {
  const directory = await assertPrivateDirectory(baseDirectory, allowTestDirectory);
  const lockPath = path.join(directory, SUBMISSION_LOCK_NAME);
  if (path.dirname(lockPath) !== directory) throw coded("handoff_path_escape");
  const started = performance.now();
  for (;;) {
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_CLOEXEC ?? 0);
    let handle;
    try {
      handle = await fs.promises.open(lockPath, flags, 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, created_at_utc: new Date().toISOString() })}\n`);
      await handle.sync();
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || mode(stat) !== 0o600) throw coded("handoff_submit_lock_invalid");
      assertOwnedByCurrentUser(stat);
      await handle.close();
      handle = null;
      return async () => removeExactSubmissionLock(lockPath, stat);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (error?.code !== "EEXIST") throw error;
      let existing;
      try {
        existing = await inspectSubmissionLock(lockPath);
      } catch (inspectError) {
        if (inspectError?.code !== "handoff_submit_lock_changed" ||
            !Number.isFinite(started) || performance.now() - started >= SUBMISSION_LOCK_WAIT_MS) {
          throw inspectError;
        }
        await sleep(SUBMISSION_LOCK_RETRY_MS);
        continue;
      }
      if (existing.initializing) {
        if (!Number.isFinite(started) || performance.now() - started >= SUBMISSION_LOCK_WAIT_MS) {
          throw coded("handoff_submit_busy");
        }
        await sleep(SUBMISSION_LOCK_RETRY_MS);
        continue;
      }
      const alive = processIsAlive(existing.pid);
      const age = Date.now() - existing.stat.mtimeMs;
      if (alive === false || (alive === null && age > SUBMISSION_LOCK_STALE_MS)) {
        await removeExactSubmissionLock(lockPath, existing.stat);
        continue;
      }
      if (!Number.isFinite(started) || performance.now() - started >= SUBMISSION_LOCK_WAIT_MS) {
        throw coded("handoff_submit_busy");
      }
      await sleep(SUBMISSION_LOCK_RETRY_MS);
    }
  }
}

export class EscalationHandoffStore {
  constructor({
    baseDirectory = DEFAULT_HANDOFF_DIRECTORY,
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    now = () => new Date(),
    randomBytes = crypto.randomBytes,
    monotonicNow = () => performance.now(),
    wait = (delayMs, signal) => sleep(delayMs, undefined, { signal }),
    allowTestDirectory = false,
  } = {}) {
    this.baseDirectory = path.resolve(baseDirectory);
    this.maxFileBytes = maxFileBytes;
    this.now = now;
    this.randomBytes = randomBytes;
    this.monotonicNow = monotonicNow;
    this.wait = wait;
    this.allowTestDirectory = allowTestDirectory === true;
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 32 * 1024 || maxFileBytes > 16 * 1024 * 1024) {
      throw coded("handoff_size_cap_invalid");
    }
    if (typeof monotonicNow !== "function" || typeof wait !== "function") throw coded("handoff_wait_clock_invalid");
  }

  async submit({ question, audience, audienceScope, alreadyTried, doneLooksLike, resultContract }) {
    const prepared = prepareSubmission({
      question,
      audience,
      audienceScope,
      alreadyTried,
      doneLooksLike,
      resultContract,
    });
    const now = this.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw coded("handoff_timestamp_invalid");
    const requestId = generateRequestId(now, this.randomBytes);
    await appendPrivateFile(
      this.baseDirectory,
      "inbox",
      submissionRecord(requestId, now, prepared),
      this.maxFileBytes,
      this.allowTestDirectory,
    );
    return Object.freeze({
      requestId,
      audience: prepared.audience,
      status: "open",
      redactions: prepared.redactions,
    });
  }

  async submitWithId({ requestId, question, audience, audienceScope, alreadyTried, doneLooksLike, resultContract }) {
    const id = exactRequestId(requestId);
    const prepared = prepareSubmission({
      question,
      audience,
      audienceScope,
      alreadyTried,
      doneLooksLike,
      resultContract,
    });
    return serializeSubmission(this.baseDirectory, async () => {
      const release = await acquireSubmissionLock(this.baseDirectory, this.allowTestDirectory);
      try {
        const inboxBefore = await readPrivateFile(
          this.baseDirectory,
          "inbox",
          this.maxFileBytes,
          this.allowTestDirectory,
        );
        const matches = recordSections(inboxBefore).filter((section) => section.id === id);
        if (matches.length > 1) throw coded("handoff_request_ambiguous");
        if (matches.length === 1) {
          const existing = parseInboxRequest(inboxBefore, id);
          if (!submissionMatches(existing, prepared)) throw coded("handoff_request_id_conflict");
          return Object.freeze({
            requestId: id,
            audience: prepared.audience,
            status: "open",
            redactions: prepared.redactions,
            reused: true,
          });
        }
        const now = this.now();
        if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw coded("handoff_timestamp_invalid");
        await appendPrivateFile(
          this.baseDirectory,
          "inbox",
          submissionRecord(id, now, prepared),
          this.maxFileBytes,
          this.allowTestDirectory,
        );
        const inboxAfter = await readPrivateFile(
          this.baseDirectory,
          "inbox",
          this.maxFileBytes,
          this.allowTestDirectory,
        );
        const installed = parseInboxRequest(inboxAfter, id);
        if (!submissionMatches(installed, prepared)) throw coded("handoff_request_id_conflict");
        return Object.freeze({
          requestId: id,
          audience: prepared.audience,
          status: "open",
          redactions: prepared.redactions,
          reused: false,
        });
      } finally {
        await release();
      }
    });
  }

  async poll(requestId, expectedAudienceScope) {
    const id = exactRequestId(requestId);
    const exactScope = exactAudienceScope(expectedAudienceScope);
    const [inboxMarkdown, outboxMarkdown] = await Promise.all([
      readPrivateFile(this.baseDirectory, "inbox", this.maxFileBytes, this.allowTestDirectory),
      readPrivateFile(this.baseDirectory, "outbox", this.maxFileBytes, this.allowTestDirectory),
    ]);
    const inbox = parseInboxRequest(inboxMarkdown, id);
    if (inbox.audienceScope !== exactScope) throw coded("escalation_audience_scope_mismatch");
    try {
      return Object.freeze({ status: "complete", result: parseOutboxResult(outboxMarkdown, id, inbox) });
    } catch (error) {
      if (error?.code === "outbox_result_pending") return Object.freeze({ status: "pending", requestId: id, audience: inbox.audience });
      throw error;
    }
  }

  async waitForResult(requestId, expectedAudienceScope, {
    signal,
    maxWaitMs = DEFAULT_WAIT_MS,
    fastWindowMs = FAST_POLL_WINDOW_MS,
    fastIntervalMs = FAST_POLL_INTERVAL_MS,
    slowIntervalMs = SLOW_POLL_INTERVAL_MS,
  } = {}) {
    const bounded = [maxWaitMs, fastWindowMs, fastIntervalMs, slowIntervalMs];
    if (bounded.some((value) => !Number.isSafeInteger(value) || value < 1) || maxWaitMs > DEFAULT_WAIT_MS ||
        fastWindowMs > maxWaitMs || fastIntervalMs > maxWaitMs || slowIntervalMs > maxWaitMs) {
      throw coded("handoff_wait_policy_invalid");
    }
    const id = exactRequestId(requestId);
    const exactScope = exactAudienceScope(expectedAudienceScope);
    const started = this.monotonicNow();
    if (!Number.isFinite(started)) throw coded("handoff_wait_clock_invalid");
    const transientCodes = new Set([
      "handoff_file_changed_during_read",
      "outbox_metadata_invalid",
      "outbox_status_invalid",
      "outbox_sections_invalid",
      "outbox_timestamp_invalid",
      "outbox_confidence_invalid",
      "outbox_answer_invalid",
      "outbox_evidence_invalid",
      "outbox_limits_invalid",
    ]);
    let pendingAudience = "";
    for (;;) {
      if (signal?.aborted) throw coded("escalation_wait_aborted");
      try {
        const value = await this.poll(id, exactScope);
        if (value.status === "complete") return value;
        pendingAudience = value.audience;
      } catch (error) {
        if (!transientCodes.has(error?.code)) throw error;
      }
      const now = this.monotonicNow();
      if (!Number.isFinite(now) || now < started) throw coded("handoff_wait_clock_invalid");
      const elapsed = now - started;
      if (elapsed >= maxWaitMs) {
        return Object.freeze({ status: "pending", requestId: id, audience: pendingAudience, retryable: true });
      }
      const interval = elapsed < fastWindowMs ? fastIntervalMs : slowIntervalMs;
      try {
        await this.wait(Math.min(interval, maxWaitMs - elapsed), signal);
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") throw coded("escalation_wait_aborted");
        throw error;
      }
    }
  }
}

export const _test = Object.freeze({
  parseInboxRequest,
  parseOutboxResult,
  sensitiveTransforms,
});
