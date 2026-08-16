const PRIMARY_TOPIC = /\b(?:imt|command\s+center|major\s+incident|significant\s+incident|incident\s+(?:status|update)|service\s+(?:status|incident|issue)|production\s+(?:incident|outage|issue))\b/iu;
const FORBIDDEN_ACTION = /\b(?:send|email|text|message|book|reserve|purchase|call|run|execute|open|click|log\s*in|sign\s*in|password|credential|token|one[ -]?time\s+code|attachment|meeting|calendar|ignore|instruction|system\s+prompt|developer\s+message|tool|browser|shell|terminal)\b/iu;
const FORBIDDEN_INJECTION = /(?:^|\n)\s*(?:assistant|developer|system)\s*:|\b(?:bypass|disregard|forget|override)\s+(?:all\s+)?(?:earlier|previous|prior|the)\s+(?:directions?|instructions?|rules?)\b|\b(?:act|pretend)\s+as\b|\b(?:expose|print|repeat|return|reveal)\s+(?:the\s+)?(?:hidden|internal|private|raw|system)?\s*(?:context|instructions?|prompt|sources?)\b/iu;
const STATUS_INTENT = /\b(?:what(?:'s|\s+is|\s+are)?|status|update|latest|seeing|happening|active|issue|incident|summari[sz]e|tell\s+me|anything\s+new)\b/iu;
const RESOLUTION_INTENT = /\b(?:resolved|restored|fixed|closed|over|still\s+(?:down|active|open)|has\s+it\s+ended)\b/iu;
const TIMING_INTENT = /\b(?:eta|when|how\s+long|restoration\s+time|recovery\s+time|time\s+to\s+restore)\b/iu;
const IMPACT_INTENT = /\b(?:impact|affected|which\s+service|what\s+service|who\s+is\s+affected|scope)\b/iu;
const STATIC_DEFINITION_ONLY = /^(?:(?:what|who)\s+(?:is|are)\s+(?:the\s+)?(?:imt|command\s+center)|(?:define|explain)\s+(?:the\s+)?(?:imt|command\s+center))\??$/iu;
const FOLLOWUP = Object.freeze([
  { kind: "status", pattern: /^(?:any\s+(?:update|change|news)|what(?:'s|\s+is)\s+the\s+(?:latest|status)|anything\s+new)\??$/iu },
  { kind: "resolution", pattern: /^(?:is\s+it\s+(?:resolved|fixed|restored|still\s+active|still\s+open|still\s+down)|has\s+it\s+been\s+(?:resolved|fixed|restored))\??$/iu },
  { kind: "timing", pattern: /^(?:what(?:'s|\s+is)\s+the\s+eta|when\s+will\s+it\s+be\s+(?:resolved|restored|fixed)|how\s+long)\??$/iu },
  { kind: "impact", pattern: /^(?:what(?:'s|\s+is)\s+the\s+impact|who\s+is\s+affected|what\s+is\s+affected)\??$/iu },
]);

/**
 * This classifier is intentionally closed and lexical. It never treats the
 * message as a prompt. A follow-up is accepted only when the caller supplies
 * a recent, same-sender primary-query proof from durable state.
 */
export function classifyAnyGroupIMTQuery(value, { followupEligible = false } = {}) {
  const raw = String(value ?? "").normalize("NFKC");
  if (!raw || raw.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(raw)) return null;
  const match = /^\s*@rico(?:\s*[:,\-])?\s+(.+?)\s*$/iu.exec(raw);
  if (!match) return null;
  const question = match[1].replace(/\s+/gu, " ").trim();
  if (!question || question.length > 460 || FORBIDDEN_ACTION.test(question) || FORBIDDEN_INJECTION.test(question)
    || /https?:\/\//iu.test(question) || /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/u.test(question)) return null;
  // Definition requests stay on Rico's existing static vocabulary path. This
  // one-purpose ingress is only for a current operational picture.
  if (STATIC_DEFINITION_ONLY.test(question)) return null;

  if (!PRIMARY_TOPIC.test(question)) {
    if (!followupEligible) return null;
    for (const item of FOLLOWUP) {
      if (item.pattern.test(question)) return Object.freeze({ kind: item.kind, followup: true });
    }
    return null;
  }
  if (RESOLUTION_INTENT.test(question)) return Object.freeze({ kind: "resolution", followup: false });
  if (TIMING_INTENT.test(question)) return Object.freeze({ kind: "timing", followup: false });
  if (IMPACT_INTENT.test(question)) return Object.freeze({ kind: "impact", followup: false });
  if (STATUS_INTENT.test(question)) return Object.freeze({ kind: "status", followup: false });
  return null;
}
