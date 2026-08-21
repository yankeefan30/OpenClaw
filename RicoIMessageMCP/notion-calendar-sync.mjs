import {
  MAX_CALENDAR_TITLE_CHARS,
  NOTION_CVS_CALENDAR_DATA_SOURCE_ID,
  NOTION_CVS_CALENDAR_DATABASE_ID,
  NOTION_CVS_CALENDAR_URL,
} from "./constants.mjs";

const CALENDAR_SELECT = new Set(["Calendar", "CVS Health", "Other"]);
const ACCOUNT_SELECT = new Set(["CVS Health", "Other"]);

export function notionCvsCalendarTarget() {
  return {
    databaseId: NOTION_CVS_CALENDAR_DATABASE_ID,
    dataSourceId: NOTION_CVS_CALENDAR_DATA_SOURCE_ID,
    url: NOTION_CVS_CALENDAR_URL,
    parent: { type: "data_source_id", data_source_id: NOTION_CVS_CALENDAR_DATA_SOURCE_ID },
  };
}

export function calendarSelectFromName(name) {
  const value = String(name ?? "").trim();
  if (CALENDAR_SELECT.has(value)) return value;
  return "Other";
}

export function accountSelectFromName(name) {
  const value = String(name ?? "").trim();
  if (ACCOUNT_SELECT.has(value)) return value;
  if (!value) return "CVS Health";
  return "Other";
}

export function eventToNotionPage(event, { account } = {}) {
  const title = clipTitle(event?.title);
  const uid = String(event?.id ?? "").trim();
  if (!uid) throw new Error("calendar_uid_required");
  const start = requireIso(event?.start, "calendar_start_invalid");
  const end = event?.end ? requireIso(event.end, "calendar_end_invalid") : start;
  const isDatetime = start.includes("T") || end.includes("T") ? 1 : 0;
  const rangeEnd = start === end ? null : end;
  return {
    properties: {
      Name: title,
      UID: uid,
      Calendar: calendarSelectFromName(event?.calendar),
      Account: accountSelectFromName(event?.account ?? account),
      Location: String(event?.location ?? "").trim().slice(0, 160),
      Status: "Confirmed",
      "date:When:start": start,
      "date:When:end": rangeEnd,
      "date:When:is_datetime": isDatetime,
    },
  };
}

export function eventsToIcs(events, { calendarName = "CVS Health", now = () => new Date() } = {}) {
  const stamp = icsUtc(now());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Rico OpenClaw//CVS Health Calendar//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${icsEscape(calendarName)}`,
  ];
  for (const event of Array.isArray(events) ? events : []) {
    const uid = String(event?.id ?? "").trim();
    const title = clipTitle(event?.title);
    if (!uid || !title) continue;
    const start = event.start ? new Date(event.start) : null;
    const end = event.end ? new Date(event.end) : start;
    if (!start || !Number.isFinite(start.getTime()) || !end || !Number.isFinite(end.getTime())) continue;
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${icsEscape(uid)}`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART:${icsUtc(start)}`);
    lines.push(`DTEND:${icsUtc(end)}`);
    lines.push(`SUMMARY:${icsEscape(title)}`);
    if (event.location) lines.push(`LOCATION:${icsEscape(String(event.location).slice(0, 160))}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return foldIcs(lines).join("\r\n") + "\r\n";
}

export function planNotionSync({ events, existingByUid = new Map(), account } = {}) {
  const creates = [];
  const updates = [];
  const unchanged = [];
  for (const event of Array.isArray(events) ? events : []) {
    const page = eventToNotionPage(event, { account });
    const existing = existingByUid.get(page.properties.UID);
    if (!existing) {
      creates.push(page);
      continue;
    }
    if (sameNotionEvent(existing.properties, page.properties)) {
      unchanged.push({ page_id: existing.page_id, uid: page.properties.UID });
      continue;
    }
    updates.push({ page_id: existing.page_id, properties: page.properties });
  }
  return {
    target: notionCvsCalendarTarget(),
    creates,
    updates,
    unchanged,
  };
}

function sameNotionEvent(left = {}, right = {}) {
  const keys = ["Name", "UID", "Calendar", "Account", "Location", "Status", "date:When:start", "date:When:end", "date:When:is_datetime"];
  return keys.every((key) => String(left[key] ?? "") === String(right[key] ?? ""));
}

function clipTitle(value) {
  const title = String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!title) throw new Error("calendar_title_invalid");
  return [...title].slice(0, MAX_CALENDAR_TITLE_CHARS).join("");
}

function requireIso(value, code) {
  const text = String(value ?? "").trim();
  const date = new Date(text);
  if (!text || !Number.isFinite(date.getTime())) throw new Error(code);
  return text;
}

function icsUtc(date) {
  const iso = new Date(date).toISOString();
  return iso.replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

function icsEscape(value) {
  return String(value ?? "").replace(/\\/gu, "\\\\").replace(/\n/gu, "\\n").replace(/,/gu, "\\,").replace(/;/gu, "\\;");
}

function foldIcs(lines) {
  const folded = [];
  for (const line of lines) {
    let remaining = line;
    folded.push(remaining.slice(0, 75));
    remaining = remaining.slice(75);
    while (remaining.length > 0) {
      folded.push(` ${remaining.slice(0, 74)}`);
      remaining = remaining.slice(74);
    }
  }
  return folded;
}
