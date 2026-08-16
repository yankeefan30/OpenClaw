import { createHash } from 'node:crypto';

const DETAIL_HOST = 'colleaguezone.cvs.com';
const ACTIVE_SIGNAL = /\b(?:active|ongoing|investigating|identified|monitoring|degrad(?:ed|ation)|disruption|multiple\s+issues?)\b/iu;
const CLOSED_SIGNAL = /\b(?:resolved|closed|restored|completed|no\s+(?:current|active)\s+issues?)\b/iu;
const FORBIDDEN_INSIGHT = /\b(?:view|generate|regenerate)\s+ai\s+insights?\b|\b(?:colleague\s+zone|servicenow|imessage|group\s+chat|limitless|plaud|recording|transcript|according\s+to\s+(?:the|an)|i\s+(?:saw|read|heard|learned))\b/iu;
const MONTHS = new Map([
  ['january', 1], ['february', 2], ['march', 3], ['april', 4], ['may', 5], ['june', 6],
  ['july', 7], ['august', 8], ['september', 9], ['october', 10], ['november', 11], ['december', 12],
]);

export function parseOverviewSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.links)) throw coded('colleague_zone_overview_snapshot_invalid');
  const unique = new Map();
  for (const link of snapshot.links.slice(0, 500)) {
    const detail = parseDetailURL(link?.href);
    if (!detail) continue;
    const candidate = Object.freeze({
      serviceId: detail.serviceId,
      detailUrl: detail.url,
      linkText: boundedText(link?.text, 400),
      contextText: boundedText(link?.contextText, 4_000),
    });
    if (!unique.has(candidate.serviceId)) unique.set(candidate.serviceId, candidate);
  }
  return Object.freeze([...unique.values()]
    .map((candidate, index) => ({ candidate, index, score: overviewPriority(candidate.contextText) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.candidate)
    .slice(0, 100));
}

export function parseActiveIncident(candidate, snapshot, { snapshotAt = new Date().toISOString() } = {}) {
  const detail = parseDetailURL(candidate?.detailUrl ?? snapshot?.url);
  if (!detail || detail.serviceId !== candidate?.serviceId) throw coded('colleague_zone_detail_source_invalid');
  const capturedAt = iso(snapshotAt, 'colleague_zone_snapshot_time_invalid');
  const record = chooseIncidentRecord(snapshot?.records);
  const body = boundedText(record?.text ?? snapshot?.bodyText, 100_000);
  const headings = Array.isArray(snapshot?.headings) ? snapshot.headings.map((item) => boundedText(item, 1_000)).filter(Boolean) : [];
  const combined = [candidate.linkText, candidate.contextText, snapshot?.title, ...headings, body]
    .map((item) => boundedText(item, 100_000))
    .filter(Boolean)
    .join('\n');
  const severity = detectSeverity(`${candidate.linkText}\n${candidate.contextText}`)
    ?? detectSeverity(body)
    ?? detectSeverity([snapshot?.title, ...headings].join('\n'));
  if (!severity) return null;
  if (/\bno\s+(?:current|active)\s+issues?\b/iu.test(combined)) return null;
  if (CLOSED_SIGNAL.test(combined) && !/\b(?:status\s*[:\-]\s*active|currently\s+active|ongoing|investigating|monitoring)\b/iu.test(combined)) return null;
  if (!ACTIVE_SIGNAL.test(combined)) return null;

  const serviceName = detectServiceName(candidate, snapshot, detail.serviceId);
  const environment = detectEnvironment(combined);
  const scopedSnapshot = record ? { ...snapshot, times: record.times ?? [], incidentId: record.incidentId ?? snapshot?.incidentId } : snapshot;
  const dateCandidates = collectDates(scopedSnapshot, body);
  const startedAt = pickLabeledDate(dateCandidates, /\b(?:start(?:ed)?|began|since|opened)\b/iu)
    ?? dateCandidates.at(0)?.iso;
  if (!startedAt) throw coded('colleague_zone_incident_started_at_missing');
  const updatedAt = pickLabeledDate(dateCandidates, /\b(?:updated?|last\s+update|modified|as\s+of)\b/iu)
    ?? dateCandidates.at(-1)?.iso
    ?? startedAt;
  const durationMinutes = detectDuration(body, startedAt, capturedAt);
  const explicitIdentity = boundedText(scopedSnapshot?.incidentId, 4_096);
  const incidentId = explicitIdentity || `cz-${sha256(`${detail.serviceId}\0${startedAt}\0${severity}`).slice(0, 40)}`;
  const existingAIInsight = existingInsight(snapshot?.aiInsightTexts);
  return Object.freeze({
    incidentId,
    serviceId: detail.serviceId,
    detailUrl: detail.url,
    severity,
    status: 'active',
    serviceName,
    environment,
    startedAt,
    updatedAt,
    durationMinutes,
    safeSummary: `${serviceName} has an active ${severity.toLowerCase()} issue in ${environment}`,
    existingAIInsight,
  });
}

function chooseIncidentRecord(records) {
  if (!Array.isArray(records)) return null;
  const ranked = records.slice(0, 500).map((record) => {
    const text = boundedText(record?.text, 20_000);
    let score = 0;
    if (!text || !/\b(?:major|significant|degrad(?:ed|ation)|disruption|issues?|incident)\b/iu.test(text)) return { score: -100, record };
    if (/\b(?:status\s*[:\-]\s*active|currently\s+active|ongoing|investigating|monitoring)\b/iu.test(text)) score += 20;
    if (/\b(?:start(?:ed)?|began|since|opened)\b/iu.test(text)) score += 6;
    if (/\b(?:duration|ended?|resolved|closed|restored)\b/iu.test(text)) score -= 12;
    if (/\bno\s+(?:current|active)\s+issues?\b/iu.test(text)) score -= 30;
    return { score, record };
  }).sort((left, right) => right.score - left.score);
  return ranked[0]?.score > 0 ? ranked[0].record : null;
}

export function parseDetailURL(value) {
  let url;
  try { url = new URL(String(value ?? '')); } catch { return null; }
  const keys = [...url.searchParams.keys()].sort();
  const serviceId = url.searchParams.get('service') ?? '';
  if (url.protocol !== 'https:' || url.hostname !== DETAIL_HOST || url.port || url.username || url.password || url.hash
    || url.pathname !== '/cz' || url.searchParams.get('id') !== 'my_services_status'
    || keys.join(',') !== 'id,service' || !serviceId || serviceId.length > 1_024
    || /[\u0000-\u001f\u007f]/u.test(serviceId)) return null;
  return Object.freeze({ serviceId, url: url.toString() });
}

export function isAuthenticatedOverview(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const currentURL = String(snapshot.url ?? '');
  let url;
  try { url = new URL(currentURL); } catch { return false; }
  if (url.hostname !== DETAIL_HOST || url.pathname !== '/cz' || url.searchParams.get('id') !== 'services_status') return false;
  if (snapshot.passwordInputPresent === true) return false;
  if (Number(snapshot.serviceLinkCount ?? 0) > 0) return true;
  return /\bcurrent\s+status\b/iu.test(boundedText(snapshot.visibleHeadingText, 4_000));
}

function detectSeverity(text) {
  const major = /\bmajor\b/iu.test(text);
  const significant = /\bsignificant\b/iu.test(text);
  if (major === significant) return null;
  if (major) return 'Major';
  if (significant) return 'Significant';
  return null;
}

function overviewPriority(text) {
  const value = boundedText(text, 4_000);
  let score = 0;
  if (detectSeverity(value)) score += 20;
  if (ACTIVE_SIGNAL.test(value)) score += 10;
  if (/\bcurrent\s+status\b/iu.test(value)) score += 5;
  if (CLOSED_SIGNAL.test(value)) score -= 20;
  return score;
}

function detectServiceName(candidate, snapshot, serviceId) {
  const values = [snapshot?.title, ...(snapshot?.headings ?? []), candidate?.linkText];
  for (const value of values) {
    let text = boundedText(value, 1_000)
      .replace(/\b(?:current\s+status|service\s+status|major|significant|multiple\s+issues?|active|resolved)\b/giu, ' ')
      .replace(/\s*::\s*(?:prod(?:uction)?|uat|qa|dev(?:elopment)?|test)\b.*$/iu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    if (/\b(?:colleague\s+zone|servicenow|view\s+ai\s+insights?)\b/iu.test(text)) continue;
    if (text.length >= 2 && isSafeOutputText(text)) return text.slice(0, 240);
  }
  return 'Affected service';
}

function detectEnvironment(text) {
  const explicit = text.match(/\b(?:environment|env)\s*[:\-]\s*(production|prod|uat|qa|test|development|dev)\b/iu)
    ?? text.match(/::\s*(production|prod|uat|qa|test|development|dev)\b/iu);
  const value = String(explicit?.[1] ?? '').toUpperCase();
  return ({ PRODUCTION: 'Production', PROD: 'Production', UAT: 'UAT', QA: 'QA', TEST: 'Test', DEVELOPMENT: 'Development', DEV: 'Development' })[value]
    ?? 'Unspecified environment';
}

function collectDates(snapshot, body) {
  const output = [];
  for (const item of Array.isArray(snapshot?.times) ? snapshot.times : []) {
    const context = boundedText(item?.contextText ?? item?.text, 2_000);
    const parsed = parseDate(item?.dateTime) ?? parseDate(item?.text);
    if (parsed) output.push({ iso: parsed, context });
  }
  const monthPattern = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(AM|PM)(?:\s*(ET|EST|EDT))?\b/giu;
  for (const match of body.matchAll(monthPattern)) {
    const parsed = newYorkISO(Number(match[3]), MONTHS.get(match[1].toLowerCase()), Number(match[2]), Number(match[4]), Number(match[5] ?? 0), match[6]);
    if (parsed) output.push({ iso: parsed, context: nearby(body, match.index ?? 0) });
  }
  const unique = new Map();
  for (const item of output) {
    const existing = unique.get(item.iso);
    if (!existing || item.context.length > existing.context.length) unique.set(item.iso, item);
  }
  return [...unique.values()].sort((left, right) => Date.parse(left.iso) - Date.parse(right.iso));
}

function parseDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function newYorkISO(year, month, day, rawHour, minute, meridiem) {
  let hour = rawHour % 12;
  if (String(meridiem).toUpperCase() === 'PM') hour += 12;
  const desired = { year, month, day, hour, minute };
  const nominal = Date.UTC(year, month - 1, day, hour, minute);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  });
  for (let offset = -12 * 60; offset <= 12 * 60; offset += 15) {
    const candidate = new Date(nominal + offset * 60_000);
    const parts = Object.fromEntries(formatter.formatToParts(candidate)
      .filter((item) => item.type !== 'literal')
      .map((item) => [item.type, Number(item.value)]));
    if (parts.year === desired.year && parts.month === desired.month && parts.day === desired.day
      && (parts.hour % 24) === desired.hour && parts.minute === desired.minute) return candidate.toISOString();
  }
  return null;
}

function pickLabeledDate(values, label) {
  const matches = values.filter((item) => label.test(item.context));
  return matches.at(-1)?.iso ?? null;
}

function detectDuration(body, startedAt, snapshotAt) {
  const hours = body.match(/\b(\d+)\s*(?:hours?|hrs?|h)\b/iu);
  const minutes = body.match(/\b(\d+)\s*(?:minutes?|mins?|m)\b/iu);
  if (hours || minutes) return Math.min(5_256_000, Number(hours?.[1] ?? 0) * 60 + Number(minutes?.[1] ?? 0));
  const difference = Math.floor((Date.parse(snapshotAt) - Date.parse(startedAt)) / 60_000);
  return Number.isInteger(difference) && difference >= 0 ? Math.min(difference, 5_256_000) : null;
}

function existingInsight(values) {
  if (!Array.isArray(values)) return Object.freeze({ present: false, safeSummary: null });
  for (const value of values) {
    const text = boundedText(value, 240);
    if (text.length >= 8 && !FORBIDDEN_INSIGHT.test(text) && isSafeOutputText(text)) {
      return Object.freeze({ present: true, safeSummary: text });
    }
  }
  return Object.freeze({ present: false, safeSummary: null });
}

function isSafeOutputText(text) {
  return !/["“”<>`{}]/u.test(text) && !/https?:\/\//iu.test(text)
    && !/\+[1-9]\d{7,14}/u.test(text) && !/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/u.test(text)
    && !/\b(?:according\s+to\s+(?:the|an)|i\s+(?:saw|read|heard|learned))\b/iu.test(text);
}

function nearby(text, index) {
  // Bind each timestamp to its immediately adjacent label. A broad window can
  // accidentally associate an "updated" timestamp with an earlier "started"
  // label after DOM whitespace normalization.
  return boundedText(text.slice(Math.max(0, index - 40), index + 80), 140);
}

function boundedText(value, maximum) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maximum);
}

function iso(value, code) {
  const date = new Date(String(value ?? ''));
  if (!Number.isFinite(date.getTime())) throw coded(code);
  return date.toISOString();
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
