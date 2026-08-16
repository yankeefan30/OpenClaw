import path from "node:path";
import { ALLOWED_TEXT_EXTENSIONS, EXECUTABLE_EXTENSIONS, IMPORT_LIMITS } from "./constants.mjs";
import { RicoSkillError, invariant } from "./errors.mjs";

const decoder = new TextDecoder("utf-8", { fatal: true });

const SECRET_RULES = [
  ["private_key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i],
  ["api_key", /\b(?:sk|xox[baprs]|gh[pousr])[-_][A-Za-z0-9_-]{16,}\b/],
  ["aws_access_key", /\bAKIA[0-9A-Z]{16}\b/],
  ["bearer_token", /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/],
  ["url_credentials", /\bhttps?:\/\/[^\s/@:]+:[^\s/@]+@/i],
  ["credential_assignment", /\b(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|session[_-]?cookie)\s*[:=]\s*["']?[^\s"']{8,}/i],
  ["cookie_header", /\b(?:cookie|set-cookie)\s*:\s*[^\r\n]{8,}/i],
];

const DIRECTIVE_RULES = [
  ["system_policy_override", /\b(?:ignore|override|bypass|disregard)\b.{0,60}\b(?:system|developer|previous|security|privacy|policy|guardrail|instruction)/i],
  ["system_policy_override", /(?:^|\s)(?:<system>|\[system\]|system prompt:|developer message:|assistant:)\s*/i],
  ["system_policy_override", /\b(?:these|this|imported)\s+instructions?\b.{0,45}\b(?:take precedence|higher priority|override|supersede)/i],
  ["system_policy_override", /\b(?:you are|act as|become)\b.{0,50}\b(?:system|developer|unrestricted|administrator|admin|owner)/i],
  ["owner_status", /\b(?:treat|recognize|consider|mark|make)\b.{0,45}\b(?:me|user|sender|bot|agent)\b.{0,35}\b(?:owner|administrator|admin|trusted|unrestricted)/i],
  ["credentials", /\b(?:read|retrieve|obtain|use|expose|reveal|store|access)\b.{0,60}\b(?:credential|password|token|cookie|secret|keychain|api key|login)/i],
  ["security_or_config_changes", /\b(?:disable|remove|weaken|change|edit|modify|rewrite)\b.{0,60}\b(?:security|guardrail|allowlist|configuration|config|policy|approval|permission)/i],
  ["email", /\b(?:send|email|mail|forward|reply)\b.{0,45}\b(?:email|mail|message|attachment|recipient)/i],
  ["email", /^\s*(?:[-*]\s+|\d+\.\s+)?(?:please\s+)?(?:email|mail|forward)\b/i],
  ["email", /(?:^|[.!?]\s+|\b(?:you|rico|agent|assistant)\s+(?:can|may|must|should|will)\s+)(?:email|mail|forward|reply|send)\b.{0,80}\b(?:email|mail|outlook|gmail|attachment|recipient|to\b)/i],
  ["messaging", /\b(?:send|text|message|reply|contact)\b.{0,45}\b(?:imessage|sms|whatsapp|slack|teams|person|contact|number|group)/i],
  ["messaging", /^\s*(?:[-*]\s+|\d+\.\s+)?(?:please\s+)?(?:text|message|contact|notify)\b/i],
  ["messaging", /(?:^|[.!?]\s+|\b(?:you|rico|agent|assistant)\s+(?:can|may|must|should|will)\s+)(?:text|message|contact|notify|reply)\b.{0,80}\b(?:imessage|sms|whatsapp|slack|teams|person|contact|number|group|them|him|her)/i],
  ["contacts", /\b(?:read|search|look up|resolve|use|access|modify|add|delete)\b.{0,50}\b(?:contact|address book|phone number|email address)/i],
  ["tools", /\b(?:call|invoke|run|execute|use|enable|grant|access|open|browse|search)\b.{0,50}\b(?:tool|browser|internet|web|mcp|shell|terminal|script|command|api|connector|chatgpt|claude|grok|gemini|perplexity)/i],
  ["tools", /["']?(?:tools?|allowed_tools|permissions?|capabilities)["']?\s*[:=]/i],
  ["tools", /\b(?:user|owner|operator|alan)\b.{0,40}\b(?:authorized|approved|granted|allows?)\b.{0,45}\b(?:all tools|tool access|external actions|unrestricted access)/i],
  ["provenance_policy_override", /\b(?:hide|conceal|omit|deny|misrepresent)\b.{0,60}\b(?:source|citation|provenance|origin|recording|access)/i],
];

const TOOL_NEEDS = [
  ["browser", /\b(?:browser|web|internet|website)\b/i],
  ["email", /\b(?:email|gmail|outlook|apple mail)\b/i],
  ["messaging", /\b(?:imessage|sms|slack|teams|message)\b/i],
  ["files", /\b(?:file|folder|drive|dropbox|sharepoint)\b/i],
  ["shell", /\b(?:shell|terminal|command line|script)\b/i],
  ["calendar", /\b(?:calendar|meeting|schedule)\b/i],
  ["mcp", /\bMCP\b/i],
  ["model", /\b(?:chatgpt|claude|grok|gemini|perplexity)\b/i],
];

export function validateRelativePath(value) {
  invariant(typeof value === "string" && value.length > 0, "unsafe_path", "An imported entry has no name.");
  invariant(!value.includes("\0") && !/[\r\n]/.test(value), "unsafe_path", "An imported entry uses an unsafe filename.");
  invariant(!value.includes("\\"), "unsafe_path", "Backslashes are not accepted in imported paths.");
  invariant(!path.posix.isAbsolute(value), "path_traversal", "Absolute paths are not accepted in imports.");
  const rawParts = value.split("/");
  invariant(rawParts.every((part) => part !== "" && part !== "." && part !== ".."), "path_traversal", "The import contains a traversal or ambiguous path component.");
  const normalized = path.posix.normalize(value);
  invariant(normalized !== ".." && !normalized.startsWith("../"), "path_traversal", "The import attempts to leave its package.");
  return normalized.normalize("NFC");
}

export function validateTextFile({ relativePath, data, mode = 0 }) {
  const normalized = validateRelativePath(relativePath);
  const extension = path.extname(normalized).toLowerCase();
  invariant((mode & 0o111) === 0, "executable_content", `Executable file permissions are not allowed: ${normalized}`);
  invariant(!EXECUTABLE_EXTENSIONS.has(extension), "executable_content", `Executable or active content is not importable: ${normalized}`);
  invariant(ALLOWED_TEXT_EXTENSIONS.has(extension), "unknown_content", `Only Markdown, plain text, JSON, and YAML resources are importable: ${normalized}`);
  invariant(data.length <= IMPORT_LIMITS.fileBytes, "file_too_large", `Imported file exceeds ${IMPORT_LIMITS.fileBytes} bytes: ${normalized}`);
  invariant(!data.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), "binary_content", `Binary content is not importable: ${normalized}`);
  invariant(!data.includes(0), "binary_content", `Binary content is not importable: ${normalized}`);
  let text;
  try { text = decoder.decode(data); }
  catch { throw new RicoSkillError("binary_content", `The import is not valid UTF-8 text: ${normalized}`); }
  invariant(!/^\s*#!/.test(text), "executable_content", `Executable script content is not importable: ${normalized}`);
  invariant(!/<\s*(?:script|iframe|object|embed)\b|javascript\s*:/i.test(text), "executable_content", `Active embedded content is not importable: ${normalized}`);
  invariant(!/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u.test(text), "unsafe_text", `Invisible or bidirectional control text is not importable: ${normalized}`);
  const controls = [...text].filter((character) => {
    const code = character.codePointAt(0);
    return code < 32 && ![9, 10, 13].includes(code);
  }).length;
  invariant(controls === 0, "binary_content", `Control characters are not importable: ${normalized}`);
  return { relativePath: normalized, extension, text: text.replace(/\r\n?/g, "\n") };
}

export function scanSecrets(text, relativePath = "source") {
  const findings = [];
  for (const [rule, expression] of SECRET_RULES) {
    const match = text.match(expression);
    if (!match) continue;
    const before = text.slice(0, match.index ?? 0);
    findings.push({ rule, relativePath, line: before.split("\n").length });
  }
  return findings;
}

export function analyzeInstructions(text) {
  const blockedLines = [];
  const keptLines = [];
  const permissionRequests = new Set();
  const toolNeeds = new Set();
  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  for (const [index, line] of lines.entries()) {
    const rules = [...new Set(DIRECTIVE_RULES.filter(([, expression]) => expression.test(line)).map(([name]) => name))];
    if (rules.length > 0) {
      rules.forEach((rule) => permissionRequests.add(rule));
      blockedLines.push({ line: index + 1, rules, preview: safePreview(line) });
      keptLines.push(`> [Removed during import: ${rules.join(", ")}]`);
    } else {
      keptLines.push(line);
    }
    for (const [name, expression] of TOOL_NEEDS) if (expression.test(line)) toolNeeds.add(name);
  }

  return {
    sanitized: keptLines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim(),
    blockedLines,
    permissionRequests: [...permissionRequests].sort(),
    toolNeeds: [...toolNeeds].sort(),
  };
}

function safePreview(line) {
  const collapsed = line.replace(/\s+/g, " ").trim();
  return collapsed.length > 140 ? `${collapsed.slice(0, 137)}…` : collapsed;
}
