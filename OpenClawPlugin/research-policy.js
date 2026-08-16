const SOURCE_KINDS = new Set([
  "public_web", "legal_case", "magazine", "newspaper", "book",
  "chatgpt", "claude", "grok", "gemini", "perplexity",
  "google_drive", "gmail", "slack", "outlook", "apple_mail", "limitless", "plaud",
]);

const CITABLE_SOURCE_KINDS = new Set(["public_web", "legal_case", "magazine", "newspaper", "book"]);
const PRIVATE_SOURCE_KINDS = new Set(["google_drive", "gmail", "slack", "outlook", "apple_mail", "limitless", "plaud"]);
const MODEL_SOURCE_KINDS = new Set(["chatgpt", "claude", "grok", "gemini", "perplexity"]);

export const RICO_RESEARCH_SYSTEM_POLICY = [
  "Use a research capability only when Rico's local broker marks that exact capability healthy for this run. Never claim that a source was searched when its broker is unavailable.",
  "ChatGPT, Claude, Grok, Gemini, and Perplexity are research assistants, not authorities and never citations.",
  "Google Drive, Gmail, Slack, Outlook, Apple Mail, private conversations, lifelogs, and recordings are private background sources. Never quote, name, link, cite, or imply those sources to another person. Never mention Limitless or PLAUD in an outbound text or email.",
  "Outbound citations may identify only public websites, legal cases, magazine articles, newspaper articles, or books. A hyperlink must be the exact verified public HTTPS URL and must contain no credentials.",
  "Approved private facts may inform the substance and personalization of an answer without disclosing their provenance. When Rico supplies a citation or hyperlink, it must come from an allowed citable authority; never fabricate public corroboration for a private fact.",
].join("\n");

// This is a last-mile disclosure gate, not a prompt-instruction substitute.
// Patterns intentionally target provenance language while leaving ordinary
// statements such as "Please arrange a meeting" and public-source references
// such as "the published court transcript" untouched.
const PRIVATE_PROVENANCE_PATTERNS = [
  // Match the two forbidden product names even when punctuation, whitespace,
  // or invisible formatting characters are inserted between their letters.
  { code: "private_source_brand", pattern: /\b(?:l[\s._-]*i[\s._-]*m[\s._-]*i[\s._-]*t[\s._-]*l[\s._-]*e[\s._-]*s[\s._-]*s|p[\s._-]*l[\s._-]*a[\s._-]*u[\s._-]*d)\b/iu },
  { code: "private_recording_source", pattern: /\b(?:life\s*-?\s*log|recorded\s+(?:conversation|meeting|call)|(?:conversation|meeting|call|audio|voice)\s+recording|meeting\s+transcript|(?:notes?|minutes)\s+from\s+(?:(?:our|your|the|a|an)\s+)?(?:(?:prior|previous|past|earlier|private)\s+)?(?:conversation|chat|discussion|meeting|call))\b/iu },
  { code: "private_conversation_reference", pattern: /\b(?:(?:our|your)\s+(?:(?:prior|previous|past|earlier|private)\s+)?|the\s+(?:prior|previous|past|earlier|private)\s+)(?:conversation|chat)\b/iu },
  // A temporal adjective may follow a determiner ("our previous chat") or
  // stand alone ("the result from a prior conversation").
  { code: "private_conversation_attribution", pattern: /\b(?:from|based\s+on|according\s+to|during|in|after|following)\s+(?:(?:our|your|the|a|an)\s+)?(?:(?:prior|previous|past|earlier|recorded|private)\s+)?(?:conversation|chat|exchange|discussion|messages?|recording|transcript)\b/iu },
  { code: "private_discussion_callback", pattern: /\b(?:as\s+(?:we|you|he|she|they)\s+(?:discussed|talked|spoke|said|mentioned|shared|explained|agreed|noted|covered)|when\s+(?:we|you\s+and\s+i)\s+(?:last\s+)?(?:spoke|talked|chatted|met|discussed)|the\s+last\s+time\s+(?:we|you\s+and\s+i)\s+(?:spoke|talked|chatted|met|discussed)|(?:we|you\s+and\s+i)\s+(?:previously\s+)?(?:talked|spoke|chatted|discussed)\s+(?:about|of))\b/iu },
  { code: "private_memory_attribution", pattern: /\b(?:(?:you|he|she|they)\s+(?:(?:said|mentioned|shared|explained|noted)\s+(?:earlier|before|previously|in\s+(?:(?:our|your|the|a|an)\s+)?(?:(?:prior|previous|past|earlier|private)\s+)?(?:conversation|chat|exchange|discussion|messages?|meeting|call|recording))|told\s+(?:me|rico))|earlier\s*,?\s*(?:you|he|she|they)\s+(?:said|mentioned|shared|explained|noted)|(?:i|rico|we)\s+(?:remember|recall)\s+(?:that\s+)?(?:you|we|our|your|the|when))\b/iu },
  { code: "private_repository_attribution", pattern: /\b(?:(?:according\s+to|from|based\s+on|per)\s+(?:(?:your|alan(?:'s)?|the)\s+)?(?:emails?|gmail|outlook(?:\s+(?:email|mailbox|messages?))?|apple\s+mail|slack(?:\s+messages?)?|google\s+drive(?:\s+(?:file|document))?|drive\s+file|mailbox|messages?|transcript)|(?:your|alan(?:'s)?|the)\s+(?:emails?|gmail|outlook(?:\s+(?:email|mailbox|messages?))?|apple\s+mail|slack(?:\s+messages?)?|google\s+drive(?:\s+(?:file|document))?|drive\s+file|mailbox|messages?|transcript)\s+(?:says?|shows?|indicates?|mentions?|states?|confirms?|reveals?))\b/iu },
  { code: "private_repository_access", pattern: /\b(?:i|rico|we)\s+(?:(?:have|had|can|could|did)\s+)?(?:access(?:ed)?|open(?:ed)?|read|re-?read|review(?:ed)?|search(?:ed)?|check(?:ed)?|consult(?:ed)?|use(?:d)?)\s+(?:(?:your|alan(?:'s)?|the)\s+)?(?:emails?|gmail|outlook(?:\s+(?:email|mailbox|messages?))?|apple\s+mail|slack(?:\s+messages?)?|google\s+drive(?:\s+(?:file|document))?|drive\s+file|mailbox)\b/iu },
  { code: "private_access_claim", pattern: /\b(?:i|rico|we)\s+(?:(?:(?:have|had|got|can|could)\s+access\s+to|(?:was|were)\s+able\s+to\s+access)\s+(?:our|your|the|a|an|alan(?:'s)?)\s+(?:(?:prior|previous|past|earlier|recorded|private)\s+)?(?:recordings?|conversations?|chats?|meetings?|calls?|lifelogs?|transcripts?|messages?)|(?:(?:have|had|can|could|did)\s+)?(?:access(?:ed)?|read|re-?read|revisit(?:ed)?|review(?:ed)?|listen(?:ed)?\s+to|hear(?:d)?|search(?:ed)?|check(?:ed)?|consult(?:ed)?|use(?:d)?)\s+(?:our|your|the|a|an|alan(?:'s)?)\s+(?:(?:prior|previous|past|earlier|recorded|private)\s+)?(?:recordings?|conversations?|chats?|meetings?|calls?|lifelogs?|transcripts?))\b/iu },
  { code: "private_source_discovery_claim", pattern: /\b(?:i|rico|we)\s+(?:found|learned|saw|read|heard|pulled|got|confirmed)\s+(?:this|that|it|the\s+(?:detail|information|answer|date|fact))?\s*(?:from|in|through|by\s+(?:reading|reviewing|listening\s+to))\s+(?:(?:your|alan(?:'s)?|the)\s+)?(?:emails?|gmail|outlook(?:\s+(?:email|mailbox|messages?))?|apple\s+mail|slack(?:\s+messages?)?|google\s+drive(?:\s+(?:file|document))?|drive\s+file|mailbox|messages?|recording|transcript|lifelog)\b/iu },
  // Colleague Zone and its AI Insights affordance are private operational
  // sources. ServiceNow is a public product name, so block it only when the
  // text attributes a fact to, or claims access to, that private source.
  { code: "private_incident_source_brand", pattern: /\b(?:colleague\s*zone|ai\s+insights?|(?:internal|cvs(?:\s+health)?)\s+service\s+status(?:\s+(?:page|dashboard))?)\b/iu },
  { code: "private_incident_source_attribution", pattern: /\b(?:(?:according\s+to|from|based\s+on|per|via|in)\s+(?:(?:the|our|your|alan(?:'s)?|cvs(?:\s+health)?(?:'s)?)\s+)?(?:service\s*now|service\s+status(?:\s+(?:page|dashboard))?)|(?:(?:the|our|your|alan(?:'s)?|cvs(?:\s+health)?(?:'s)?)\s+)?(?:service\s*now|service\s+status(?:\s+(?:page|dashboard))?)\s+(?:says?|shows?|indicates?|mentions?|states?|confirms?|reveals?))\b/iu },
  { code: "private_incident_source_access", pattern: /\b(?:i|rico|we)\s+(?:(?:have|had|can|could|did)\s+)?(?:access(?:ed)?|open(?:ed)?|read|re-?read|review(?:ed)?|search(?:ed)?|check(?:ed)?|consult(?:ed)?|use(?:d)?)\s+(?:(?:the|our|your|alan(?:'s)?|cvs(?:\s+health)?(?:'s)?)\s+)?(?:service\s*now|service\s+status(?:\s+(?:page|dashboard))?)\b/iu },
];

function normalizeDisclosureText(content) {
  return String(content ?? "")
    .normalize("NFKC")
    // Remove format controls that could split a forbidden source name. Other
    // whitespace is collapsed so a newline cannot defeat a phrase boundary.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu, "")
    .replace(/\s+/gu, " ");
}

export function privateProvenanceDisclosureReason(content) {
  const value = normalizeDisclosureText(content);
  return PRIVATE_PROVENANCE_PATTERNS.find(({ pattern }) => pattern.test(value))?.code;
}

export function isCitableResearchSource(source) {
  return CITABLE_SOURCE_KINDS.has(String(source ?? ""));
}

export function safePublicCitationURL(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "https:" && !url.username && !url.password && Boolean(url.hostname) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function exactKeys(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const permitted = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) && keys.every((key) => permitted.has(key));
}

function safeDigest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

export function validateResearchEvidence(value) {
  if (!exactKeys(value, ["id", "source", "use", "title", "locatorDigest", "collectedAt"], ["publicURL"]) ||
      typeof value.id !== "string" || value.id.length > 100 || !SOURCE_KINDS.has(value.source) ||
      !["private_background", "model_lead", "citable_authority"].includes(value.use) ||
      typeof value.title !== "string" || value.title.trim() !== value.title || !value.title || value.title.length > 300 ||
      !safeDigest(value.locatorDigest) || !Number.isFinite(Date.parse(value.collectedAt))) return false;

  if (value.use === "citable_authority" && !CITABLE_SOURCE_KINDS.has(value.source)) return false;
  if (CITABLE_SOURCE_KINDS.has(value.source) && value.use !== "citable_authority") return false;
  if (value.publicURL !== undefined && safePublicCitationURL(value.publicURL) !== value.publicURL) return false;
  if ((PRIVATE_SOURCE_KINDS.has(value.source) || MODEL_SOURCE_KINDS.has(value.source)) && value.publicURL !== undefined) return false;
  if (["public_web", "magazine", "newspaper"].includes(value.source) && value.publicURL === undefined) return false;
  return true;
}

/**
 * A response may cite only exact evidence IDs and exact URLs emitted by the
 * governed broker. Text supplied by a model never creates citation authority.
 */
export function validateOutboundResearchCitations(citations, evidence) {
  if (!Array.isArray(citations) || !Array.isArray(evidence) || !evidence.every(validateResearchEvidence)) {
    return { allow: false, reason: "research_evidence_invalid" };
  }
  const byID = new Map(evidence.map((item) => [item.id, item]));
  const seen = new Set();
  for (const citation of citations) {
    if (!exactKeys(citation, ["evidenceId", "label"], ["hyperlink"]) ||
        typeof citation.evidenceId !== "string" || typeof citation.label !== "string" ||
        !citation.label.trim() || citation.label.length > 300 || seen.has(citation.evidenceId)) {
      return { allow: false, reason: "research_citation_invalid" };
    }
    seen.add(citation.evidenceId);
    const item = byID.get(citation.evidenceId);
    if (!item || item.use !== "citable_authority" || !CITABLE_SOURCE_KINDS.has(item.source)) {
      return { allow: false, reason: "research_citation_not_public_authority" };
    }
    if ((citation.hyperlink ?? undefined) !== (item.publicURL ?? undefined)) {
      return { allow: false, reason: "research_citation_url_mismatch" };
    }
  }
  return { allow: true };
}

export function validateResearchCapability(value) {
  return exactKeys(value, ["source", "state", "capabilityReference"]) && SOURCE_KINDS.has(value.source) &&
    ["unavailable", "allowed", "configured", "healthy"].includes(value.state) &&
    typeof value.capabilityReference === "string" && value.capabilityReference.length > 0 && value.capabilityReference.length <= 180 &&
    !/(?:password|secret|token=|cookie|bearer\s|api[_-]?key)/iu.test(value.capabilityReference);
}

export function authorizeResearchSources(requestedSources, capabilities) {
  if (!Array.isArray(requestedSources) || !Array.isArray(capabilities) ||
      requestedSources.some((source) => !SOURCE_KINDS.has(source))) return { allow: false, reason: "research_request_invalid" };
  for (const source of new Set(requestedSources)) {
    const matches = capabilities.filter((item) => item?.source === source && validateResearchCapability(item));
    if (matches.length !== 1 || matches[0].state !== "healthy") {
      return { allow: false, reason: "research_capability_unverified", source };
    }
  }
  return { allow: true };
}
