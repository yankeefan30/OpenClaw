import crypto from "node:crypto";
import net from "node:net";

export const CURRENT_STATUS_RESULT_CONTRACT_VERSION = 1;
export const CURRENT_STATUS_RENDER_PROOF_VERSION = 1;
export const CURRENT_STATUS_REQUEST_CONTRACT = "imt-current-status/v1";
export const DEFAULT_CURRENT_STATUS_MAX_AGE_MS = 10 * 60 * 1000;
export const DEFAULT_CURRENT_STATUS_FUTURE_SKEW_MS = 2 * 60 * 1000;

const MAX_ANSWER_CHARS = 3_000;
const MAX_CITATIONS = 6;
const MAX_CITATION_TITLE_CHARS = 240;
const MAX_CITATION_URL_CHARS = 2_048;
// This contract is populated by the Polar research worker. That worker is not
// a trusted host attestor, so it may return only public research or an
// unverified result. `official_live` is recognized below solely so an attempted
// self-attestation fails with an explicit, stable reason code.
const RESEARCH_SOURCE_CLASSES = new Set([
  "public_authoritative",
  "public_secondary",
  "unverified",
]);
const NON_PUBLIC_HOST_SUFFIXES = Object.freeze([
  ".corp",
  ".home",
  ".internal",
  ".invalid",
  ".lan",
  ".local",
  ".localhost",
  ".onion",
  ".test",
]);
const RESERVED_PUBLIC_HOSTS = new Set(["example.com", "example.net", "example.org"]);
const SENSITIVE_QUERY_NAMES = /(?:^|[_-])(?:access|auth|credential|key|password|secret|session|sig|signature|token)(?:$|[_-])/iu;
const FORBIDDEN_OUTPUT = Object.freeze([
  /(?:^|\n)\s*@rico\b/iu,
  /(?:^|\n)\s*Rico\s*:/iu,
  /(?:^|\n)\s*Sources?\s*:/iu,
  /(?:^|\n)\s*(?:assistant|developer|system)\s*:/iu,
  /<\|(?:assistant|developer|im_end|im_start|system)/iu,
  /\bignore\s+(?:all\s+)?(?:prior|previous)\s+instructions\b/iu,
  /\b(?:polar|grok(?:bot)?|xai|chatgpt|openai|claude|anthropic|gemini|perplexity|qwen|lm\s*studio)\b/iu,
  /\b(?:limitless|plaud|colleague\s*zone|research\s*bench|internal\s*handoff)\b/iu,
  /\b(?:internal|private|our|cvs(?:\s+health)?(?:['’]s)?)\s+(?:service[ -]?now|servicenow|moveworks)\b/iu,
  /\b(?:service[ -]?now|servicenow|moveworks)\s+(?:instance|tenant|ticket|record)\b/iu,
  /\b(?:dispatch|result)\.json\b/iu,
  /\b(?:inbox|outbox)\.md\b/iu,
  /\brico_[0-9]{8}T[0-9]{9}Z_[a-f0-9]{32}\b/u,
  /(?:^|[\s"'(])(?:~\/|\/Users\/|\/home\/|[A-Za-z]:\\)/u,
  /\b(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|password|secret)\b\s*[:=]/iu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/iu,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/iu,
  /\+\d(?:[\s().-]*\d){7,14}(?!\d)/u,
  /(?<![\p{L}\p{N}])(?:\(\d{3}\)|\d{3})[ .-]*\d{3}[ .-]*\d{4}(?![\p{L}\p{N}])/u,
  /https?:\/\/|\bwww\./iu,
  /(?:^|[.!?:;]\s+|\n)\s*(?:please\s+)?(?:click(?:\s+here)?|open\s+(?:a|the|this)|log\s+in|login|send|upload|enter\s+(?:a|the|your)?\s*(?:credential|password|token)|provide\s+(?:a|the|your)?\s*(?:credential|password|token))\b/iu,
  /\b(?:please|must|should|need\s+to|you\s+must|you\s+should)\s+(?:click|open|log\s+in|login|send|upload|enter|provide)\b/iu,
]);

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value, { max, code, multiline = false } = {}) {
  const text = String(value ?? "").normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  const controls = multiline
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u
    : /[\u0000-\u001f\u007f-\u009f]/u;
  if (!text || text.length > max || controls.test(text)) throw coded(code);
  return text;
}

function exactIso(value, code) {
  const text = normalizeText(value, { max: 40, code });
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== text) throw coded(code);
  return text;
}

function exactNow(value) {
  const now = typeof value === "function" ? value() : value;
  const date = now === undefined ? new Date() : now;
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw coded("current_status_clock_invalid");
  return new Date(date);
}

function exactBound(value, fallback, code) {
  const number = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(number) || number < 1 || number > 24 * 60 * 60 * 1000) throw coded(code);
  return number;
}

function exactSubject(value) {
  const text = normalizeText(value ?? "IMT", { max: 80, code: "current_status_subject_invalid" });
  if (!/^[\p{L}\p{N}][\p{L}\p{N} .&'()/-]{0,79}$/u.test(text)) throw coded("current_status_subject_invalid");
  return text;
}

function assertSafeOutput(value, { max = MAX_ANSWER_CHARS, code = "current_status_answer_unsafe", multiline = true } = {}) {
  const text = normalizeText(value, { max, code, multiline });
  if (FORBIDDEN_OUTPUT.some((pattern) => pattern.test(text))) throw coded(code);
  return text;
}

function exactPublicHttpsUrl(value) {
  const raw = normalizeText(value, { max: MAX_CITATION_URL_CHARS, code: "current_status_citation_invalid" });
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw coded("current_status_citation_invalid");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) {
    throw coded("current_status_citation_invalid");
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (!hostname || net.isIP(hostname) !== 0 || hostname === "localhost" || !hostname.includes(".") ||
      NON_PUBLIC_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
      [...RESERVED_PUBLIC_HOSTS].some((reserved) => hostname === reserved || hostname.endsWith(`.${reserved}`)) ||
      hostname === "colleaguezone.cvs.com" || hostname.endsWith(".service-now.com") ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(hostname)) {
    throw coded("current_status_citation_not_public");
  }
  for (const name of parsed.searchParams.keys()) {
    if (SENSITIVE_QUERY_NAMES.test(name)) throw coded("current_status_citation_sensitive_query");
  }
  let decodedLocation;
  try {
    decodedLocation = decodeURIComponent(`${parsed.pathname}${parsed.search}`);
  } catch {
    throw coded("current_status_citation_invalid");
  }
  if (FORBIDDEN_OUTPUT.some((pattern) => pattern.test(decodedLocation))) {
    throw coded("current_status_citation_private_content");
  }
  parsed.hash = "";
  return parsed.toString();
}

function exactCitation(value) {
  if (!isObject(value)) throw coded("current_status_citation_invalid");
  const keys = Object.keys(value).sort();
  if (keys.some((key) => !["publishedAt", "title", "url"].includes(key))) {
    throw coded("current_status_citation_invalid");
  }
  const title = assertSafeOutput(value.title, {
    max: MAX_CITATION_TITLE_CHARS,
    code: "current_status_citation_invalid",
    multiline: false,
  });
  const url = exactPublicHttpsUrl(value.url);
  const publishedAt = value.publishedAt === undefined || value.publishedAt === null
    ? null
    : exactIso(value.publishedAt, "current_status_citation_invalid");
  return Object.freeze({ title, url, publishedAt });
}

function exactCitations(value, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length < 1) || value.length > MAX_CITATIONS) {
    throw coded("current_status_citations_invalid");
  }
  const normalized = value.map(exactCitation).sort((left, right) =>
    left.url.localeCompare(right.url) || left.title.localeCompare(right.title));
  const seen = new Set();
  for (const citation of normalized) {
    if (seen.has(citation.url)) throw coded("current_status_citation_duplicate");
    seen.add(citation.url);
  }
  return Object.freeze(normalized);
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function sourceRef(value) {
  return `sha256:${crypto.createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`;
}

function neutralText(subject) {
  return `Rico: I couldn’t verify a current ${subject} update within this response, so I won’t guess. Please ask Rico again.`;
}

function citationLines(citations) {
  return citations.map((citation) => `${citation.title}: ${citation.url}`);
}

function publicContextPrefix(subject) {
  return `Rico: I could not verify the current official ${subject} view. This is bounded public context and may not reflect what IMT is seeing now:`;
}

function publicContextText(subject, answer, citations) {
  return [publicContextPrefix(subject), "", answer, "", "Sources:", ...citationLines(citations)].join("\n");
}

function neutralProof(subject, reasonCode) {
  const canonical = Object.freeze({
    contractVersion: CURRENT_STATUS_RESULT_CONTRACT_VERSION,
    kind: "neutral",
    reasonCode,
    subject,
    verified: false,
  });
  return Object.freeze({
    version: CURRENT_STATUS_RENDER_PROOF_VERSION,
    kind: "neutral",
    subject,
    text: neutralText(subject),
    verified: false,
    neutral: true,
    sourceClass: "unverified",
    observedAt: null,
    citations: Object.freeze([]),
    sourceRef: sourceRef(canonical),
    reasonCode,
  });
}

function contractCandidate(value) {
  const result = isObject(value?.result) ? value.result : value;
  if (!isObject(result)) throw coded("current_status_result_invalid");
  return result;
}

export function normalizeCurrentStatusResultContract(value, { required = false } = {}) {
  const result = contractCandidate(value);
  const fieldNames = ["resultContractVersion", "observedAt", "sourceClass", "publicCitations"];
  const present = fieldNames.filter((name) => Object.hasOwn(result, name));
  if (present.length === 0) {
    if (required) throw coded("current_status_contract_required");
    return null;
  }
  if (present.length !== fieldNames.length) throw coded("current_status_contract_incomplete");
  if (result.resultContractVersion !== CURRENT_STATUS_RESULT_CONTRACT_VERSION) {
    throw coded("current_status_contract_version_invalid");
  }
  const sourceClass = normalizeText(result.sourceClass, {
    max: 40,
    code: "current_status_source_class_invalid",
  });
  if (sourceClass === "official_live") throw coded("current_status_official_attestation_required");
  if (!RESEARCH_SOURCE_CLASSES.has(sourceClass)) throw coded("current_status_source_class_invalid");
  const observedAt = result.observedAt === null && sourceClass === "unverified"
    ? null
    : exactIso(result.observedAt, "current_status_observation_invalid");
  const publicCitations = exactCitations(result.publicCitations, { allowEmpty: true });
  assertSafeOutput(result.answer);
  return Object.freeze({
    resultContractVersion: CURRENT_STATUS_RESULT_CONTRACT_VERSION,
    observedAt,
    sourceClass,
    publicCitations,
  });
}

export function currentStatusDispatchRequirements() {
  return Object.freeze({
    id: CURRENT_STATUS_REQUEST_CONTRACT,
    resultContractVersion: CURRENT_STATUS_RESULT_CONTRACT_VERSION,
    requiredFields: Object.freeze([
      "resultContractVersion",
      "observedAt",
      "sourceClass",
      "publicCitations",
    ]),
    sourceClasses: Object.freeze([...RESEARCH_SOURCE_CLASSES]),
    instruction: [
      "Return the four required fields in RESULT.json.",
      "Use an exact UTC ISO timestamp for observedAt when a source was observed.",
      "Use observedAt null, sourceClass unverified, and publicCitations [] when current status cannot be established.",
      "Each citation must have title, public https URL, and optional exact UTC ISO publishedAt.",
      "This is a research-only contract: use only sourceClass public_authoritative, public_secondary, or unverified; never return official_live.",
      "A research worker cannot attest IMT's official live state. Fresh high-confidence public_authoritative or public_secondary material may be rendered only as explicitly caveated public context, never as IMT's official current view.",
      "Do not include provider names, private-system attribution, personal data, internal IDs, file paths, or credentials in answer or citations.",
    ].join(" "),
  });
}

function reasonFor(error) {
  const code = String(error?.code ?? "");
  const allowed = new Set([
    "current_status_answer_unsafe",
    "current_status_citation_duplicate",
    "current_status_citation_invalid",
    "current_status_citation_not_public",
    "current_status_citation_private_content",
    "current_status_citation_sensitive_query",
    "current_status_citations_invalid",
    "current_status_clock_invalid",
    "current_status_confidence_insufficient",
    "current_status_contract_legacy",
    "current_status_contract_incomplete",
    "current_status_contract_required",
    "current_status_contract_version_invalid",
    "current_status_observation_future",
    "current_status_observation_invalid",
    "current_status_observation_stale",
    "current_status_official_attestation_required",
    "current_status_result_invalid",
    "current_status_source_class_invalid",
    "current_status_source_unverified",
  ]);
  return allowed.has(code) ? code : "current_status_contract_invalid";
}

function sourcedProof(result, subject, now, maxAgeMs, futureSkewMs) {
  if (result.resultContractVersion === undefined) throw coded("current_status_contract_legacy");
  const contract = normalizeCurrentStatusResultContract(result, { required: true });
  const { sourceClass, observedAt } = contract;
  if (sourceClass === "unverified") throw coded("current_status_source_unverified");
  if (String(result.confidence ?? "").trim() !== "high") throw coded("current_status_confidence_insufficient");
  if (observedAt === null) throw coded("current_status_observation_invalid");
  const observedMs = Date.parse(observedAt);
  if (observedMs > now.getTime() + futureSkewMs) throw coded("current_status_observation_future");
  if (now.getTime() - observedMs > maxAgeMs) throw coded("current_status_observation_stale");
  const answer = assertSafeOutput(result.answer);
  const citations = exactCitations(contract.publicCitations);
  const kind = "public_context";
  const canonical = Object.freeze({
    answer,
    citations,
    confidence: "high",
    contractVersion: CURRENT_STATUS_RESULT_CONTRACT_VERSION,
    observedAt,
    sourceClass,
    subject,
    kind,
  });
  return Object.freeze({
    version: CURRENT_STATUS_RENDER_PROOF_VERSION,
    kind,
    subject,
    text: publicContextText(subject, answer, citations),
    verified: false,
    neutral: false,
    sourceClass,
    observedAt,
    citations,
    sourceRef: sourceRef(canonical),
    reasonCode: "bounded_public_context",
  });
}

export function renderCurrentStatusResult(value, {
  subject = "IMT",
  now,
  maxAgeMs,
  futureSkewMs,
} = {}) {
  let exact;
  try {
    exact = exactSubject(subject);
  } catch {
    exact = "IMT";
  }
  try {
    const clock = exactNow(now);
    const age = exactBound(maxAgeMs, DEFAULT_CURRENT_STATUS_MAX_AGE_MS, "current_status_max_age_invalid");
    const skew = exactBound(futureSkewMs, DEFAULT_CURRENT_STATUS_FUTURE_SKEW_MS, "current_status_future_skew_invalid");
    return sourcedProof(contractCandidate(value), exact, clock, age, skew);
  } catch (error) {
    return neutralProof(exact, reasonFor(error));
  }
}

export function validateCurrentStatusRender(value, { now, maxAgeMs, futureSkewMs } = {}) {
  if (!isObject(value) || value.version !== CURRENT_STATUS_RENDER_PROOF_VERSION) {
    throw coded("current_status_render_invalid");
  }
  const subject = exactSubject(value.subject);
  if (!["neutral", "public_context"].includes(value.kind) ||
      typeof value.verified !== "boolean" || typeof value.neutral !== "boolean") {
    throw coded("current_status_render_invalid");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(String(value.sourceRef ?? ""))) throw coded("current_status_render_invalid");
  if (value.kind === "neutral") {
    const reasonCode = normalizeText(value.reasonCode, { max: 80, code: "current_status_render_invalid" });
    if (value.kind !== "neutral" || value.neutral !== true || value.verified !== false ||
        !/^current_status_[a-z0-9_]+$/u.test(reasonCode) || value.sourceClass !== "unverified" ||
        value.observedAt !== null || !Array.isArray(value.citations) || value.citations.length !== 0 ||
        value.text !== neutralText(subject)) {
      throw coded("current_status_render_invalid");
    }
    const canonical = {
      contractVersion: CURRENT_STATUS_RESULT_CONTRACT_VERSION,
      kind: "neutral",
      reasonCode,
      subject,
      verified: false,
    };
    if (value.sourceRef !== sourceRef(canonical)) throw coded("current_status_render_hash_mismatch");
    return neutralProof(subject, reasonCode);
  }
  if (value.kind !== "public_context" || value.neutral !== false || value.verified !== false ||
      value.reasonCode !== "bounded_public_context" ||
      !["public_authoritative", "public_secondary"].includes(value.sourceClass)) {
    throw coded("current_status_render_invalid");
  }
  const observedAt = exactIso(value.observedAt, "current_status_render_invalid");
  const clock = exactNow(now);
  const age = exactBound(maxAgeMs, DEFAULT_CURRENT_STATUS_MAX_AGE_MS, "current_status_max_age_invalid");
  const skew = exactBound(futureSkewMs, DEFAULT_CURRENT_STATUS_FUTURE_SKEW_MS, "current_status_future_skew_invalid");
  if (Date.parse(observedAt) > clock.getTime() + skew) throw coded("current_status_render_observation_future");
  if (clock.getTime() - Date.parse(observedAt) > age) throw coded("current_status_render_observation_stale");
  const citations = exactCitations(value.citations);
  const suffix = `\n\nSources:\n${citationLines(citations).join("\n")}`;
  const text = normalizeText(value.text, {
    max: MAX_ANSWER_CHARS + (MAX_CITATIONS * (MAX_CITATION_TITLE_CHARS + MAX_CITATION_URL_CHARS + 4)),
    code: "current_status_render_invalid",
    multiline: true,
  });
  if (!text.endsWith(suffix)) throw coded("current_status_render_invalid");
  const body = text.slice(0, -suffix.length);
  const prefix = `${publicContextPrefix(subject)}\n\n`;
  if (!body.startsWith(prefix)) throw coded("current_status_render_invalid");
  const answer = assertSafeOutput(body.slice(prefix.length));
  const expectedText = publicContextText(subject, answer, citations);
  if (text !== expectedText) throw coded("current_status_render_invalid");
  const canonical = {
    answer,
    citations,
    confidence: "high",
    contractVersion: CURRENT_STATUS_RESULT_CONTRACT_VERSION,
    observedAt,
    sourceClass: value.sourceClass,
    subject,
    kind: value.kind,
  };
  if (value.sourceRef !== sourceRef(canonical)) throw coded("current_status_render_hash_mismatch");
  return Object.freeze({
    version: CURRENT_STATUS_RENDER_PROOF_VERSION,
    kind: value.kind,
    subject,
    text,
    verified: false,
    neutral: false,
    sourceClass: value.sourceClass,
    observedAt,
    citations,
    sourceRef: value.sourceRef,
    reasonCode: value.reasonCode,
  });
}

export const _test = Object.freeze({
  exactPublicHttpsUrl,
  neutralText,
  publicContextPrefix,
  sourceRef,
  stableJson,
});
