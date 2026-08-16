const TIME_ZONE = "America/New_York";
const WEEKDAY_CRON = "1-5";
const OWNER_ALIASES = new Set(["me", "myself", "alan", "owner"]);

export function normalizeHandle(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  for (const prefix of ["imessage:", "sms:", "tel:", "mailto:"]) {
    if (lower.startsWith(prefix)) return normalizeHandle(raw.slice(prefix.length));
  }
  if (raw.includes("@")) return lower;
  const digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+")) return digits ? `+${digits}` : "";
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits || lower;
}

function stripQuotes(value) {
  const text = String(value ?? "").trim();
  if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function formatOffset(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const tz = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT-4";
  const match = tz.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/u);
  if (!match) return "-04:00";
  return `${match[1]}${String(match[2]).padStart(2, "0")}:${match[3] ?? "00"}`;
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date);
  const read = (type) => parts.find((part) => part.type === type)?.value;
  return {
    year: Number(read("year")),
    month: Number(read("month")),
    day: Number(read("day")),
    hour: Number(read("hour")),
    minute: Number(read("minute")),
    second: Number(read("second")),
    weekday: read("weekday"),
  };
}

function isoInZone(parts, timeZone, from = new Date()) {
  const offset = formatOffset(from, timeZone);
  const iso = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second ?? 0).padStart(2, "0")}${offset}`;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  return iso;
}

function parseClock(value) {
  const raw = String(value ?? "").trim().toLowerCase().replace(/\s+/g, "");
  const match = raw.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/u);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridian = match[3];
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  if (meridian) {
    if (hour < 1 || hour > 12) return null;
    if (meridian === "am") hour = hour === 12 ? 0 : hour;
    if (meridian === "pm") hour = hour === 12 ? 12 : hour + 12;
  }
  return { hour, minute };
}

function addCalendarDays(parts, days) {
  const utc = Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour, parts.minute, parts.second ?? 0);
  const date = new Date(utc);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second ?? 0,
  };
}

function parseRelativeDuration(value) {
  const match = String(value ?? "").trim().toLowerCase().match(/^(\d+)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d)$/u);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isInteger(amount) || amount <= 0 || amount > 60 * 24 * 30) return null;
  if (unit.startsWith("m")) return amount * 60 * 1000;
  if (unit.startsWith("h")) return amount * 60 * 60 * 1000;
  return amount * 24 * 60 * 60 * 1000;
}

function parseWhen({ fragment, now, timeZone }) {
  const text = String(fragment ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!text) return { ok: false, error: "A time is required." };

  const relative = text.match(/^(?:in\s+)?(\d+\s*(?:minutes?|mins?|m|hours?|hrs?|h|days?|d))$/u);
  if (relative) {
    const ms = parseRelativeDuration(relative[1]);
    if (!ms) return { ok: false, error: "That delay is not a supported reminder window." };
    return { ok: true, schedule: { type: "at", at: new Date(now.getTime() + ms).toISOString(), deleteAfterRun: true } };
  }

  const every = text.match(/^every\s+(morning|weekday|weekdays|day|daily)(?:\s+at\s+(.+))?$/u)
    || text.match(/^(?:each|every)\s+(weekday|weekdays|day)s?\s+at\s+(.+)$/u);
  if (every) {
    const kind = every[1];
    const clock = parseClock(every[2] ?? (kind === "morning" ? "8am" : "9am"));
    if (!clock) return { ok: false, error: "Rico needs a clock time such as 8am or 7:30." };
    const dow = kind.includes("weekday") || kind === "morning" ? WEEKDAY_CRON : "*";
    return {
      ok: true,
      schedule: {
        type: "cron",
        expr: `${clock.minute} ${clock.hour} * * ${dow}`,
        tz: timeZone,
        deleteAfterRun: false,
      },
    };
  }

  const atMatch = text.match(/^(tomorrow\s+)?(?:at\s+)?(.+)$/u);
  if (atMatch) {
    const clock = parseClock(atMatch[2]);
    if (!clock) return { ok: false, error: "Rico could not read that time." };
    const parts = zonedParts(now, timeZone);
    let target = { ...parts, hour: clock.hour, minute: clock.minute, second: 0 };
    const tomorrow = Boolean(atMatch[1]);
    const isoNow = isoInZone({ ...parts, second: parts.second ?? 0 }, timeZone, now);
    let iso = isoInZone(target, timeZone, now);
    if (!iso) return { ok: false, error: "Rico could not build that send time." };
    if (tomorrow || (!tomorrow && iso <= isoNow)) {
      target = addCalendarDays(target, 1);
      iso = isoInZone(target, timeZone, now);
    }
    if (!iso) return { ok: false, error: "Rico could not build that send time." };
    return { ok: true, schedule: { type: "at", at: iso, deleteAfterRun: true } };
  }

  return { ok: false, error: "Rico could not read that schedule." };
}

export function resolveRecipient({ token, ownerHandle, identities }) {
  const raw = stripQuotes(token).trim();
  if (!raw) return { ok: false, error: "A recipient is required." };
  if (OWNER_ALIASES.has(raw.toLowerCase())) {
    const handle = normalizeHandle(ownerHandle);
    return handle ? { ok: true, handle, displayName: "Alan" } : { ok: false, error: "Owner handle is unavailable." };
  }
  const asHandle = normalizeHandle(raw);
  const people = Array.isArray(identities) ? identities : [];
  const matches = people.filter((identity) => {
    if (!identity || identity.kind === "group" || identity.access === "blocked") return false;
    if (normalizeHandle(identity.target) === asHandle) return true;
    return String(identity.displayName ?? "").trim().toLowerCase() === raw.toLowerCase();
  });
  if (matches.length === 1) {
    const handle = normalizeHandle(matches[0].target);
    if (!handle) return { ok: false, error: "That contact has no usable iMessage address." };
    return { ok: true, handle, displayName: matches[0].displayName ?? handle };
  }
  if (matches.length > 1) return { ok: false, error: "That name matches more than one approved contact." };
  if (/^\+[1-9]\d{6,14}$/u.test(asHandle) && people.some((identity) => normalizeHandle(identity.target) === asHandle && identity.access !== "blocked")) {
    return { ok: true, handle: asHandle, displayName: asHandle };
  }
  return { ok: false, error: "That person is not on Rico's approved iMessage list." };
}

function buildName({ recipient, when }) {
  const stamp = String(when).replace(/[^a-z0-9]+/giu, "-").replace(/^-|-$/gu, "").slice(0, 40).toLowerCase();
  return `rico-wf-${stamp || "job"}-${normalizeHandle(recipient).replace(/\D/g, "").slice(-4) || "me"}`;
}

export function compileNaturalLanguage({
  text,
  now = new Date(),
  timeZone = TIME_ZONE,
  ownerHandle,
  identities,
} = {}) {
  const raw = String(text ?? "").trim();
  if (!raw) return { ok: false, error: "Describe the text or workflow you want Rico to run." };
  const source = raw.replace(/\s+/g, " ");

  const scheduleText = source.match(/^(?:text|message|remind)\s+(.+?)\s+(every\s+.+|tomorrow(?:\s+at\s+.+)?|at\s+.+|in\s+.+)$/iu)
    || source.match(/^every\s+(.+?),\s*(?:text|message|remind)\s+(.+)$/iu)
    || source.match(/^(?:schedule|set)\s+(?:a\s+)?(?:text|message|reminder)\s+(?:to\s+)?(.+?)\s+(every\s+.+|tomorrow(?:\s+at\s+.+)?|at\s+.+|in\s+.+)$/iu);

  let recipientToken = "me";
  let body;
  let whenFragment;

  const textMe = source.match(/^(?:text|message|remind)\s+(me|myself|alan)\s+(?:to\s+|that\s+)?(?:["“](.+)["”]|(.+))\s+(every\s+.+|tomorrow(?:\s+at\s+.+)?|at\s+.+|in\s+.+)$/iu);
  const textNamed = source.match(/^(?:text|message)\s+([^,]+?)\s+(?:["“](.+)["”]|that\s+(.+)|(.+))\s+(every\s+.+|tomorrow(?:\s+at\s+.+)?|at\s+.+|in\s+.+)$/iu);
  const everyLeading = source.match(/^every\s+(.+?)\s+(?:text|message|remind)\s+(me|myself|alan|[^,]+?)\s+(?:to\s+|that\s+)?(?:["“](.+)["”]|(.+))$/iu);

  if (textMe) {
    recipientToken = textMe[1];
    body = stripQuotes(textMe[2] ?? textMe[3] ?? "");
    whenFragment = textMe[4];
  } else if (everyLeading) {
    whenFragment = `every ${everyLeading[1]}`;
    recipientToken = everyLeading[2];
    body = stripQuotes(everyLeading[3] ?? everyLeading[4] ?? "");
  } else if (textNamed) {
    recipientToken = textNamed[1];
    body = stripQuotes(textNamed[2] ?? textNamed[3] ?? textNamed[4] ?? "");
    whenFragment = textNamed[5];
  } else if (scheduleText) {
    return { ok: false, needsClarification: true, error: "Tell Rico who to text, the exact words, and when. Example: text me 'standup in 10' at 8:50am." };
  } else {
    return { ok: false, needsClarification: true, error: "Rico can install this if you name the person, the exact text, and the time. Example: every weekday at 8am text me 'review the ISTS board'." };
  }

  const recipient = resolveRecipient({ token: recipientToken, ownerHandle, identities });
  if (!recipient.ok) return recipient;
  const when = parseWhen({ fragment: whenFragment, now, timeZone });
  if (!when.ok) return when;
  const message = stripQuotes(body).replace(/\s+/g, " ").trim();
  if (message.length < 1 || message.length > 1000) return { ok: false, error: "The scheduled text must be 1 to 1000 characters." };

  const plan = {
    schemaVersion: 1,
    kind: "schedule_text",
    name: buildName({ recipient: recipient.handle, when: when.schedule.expr ?? when.schedule.at }),
    recipient: recipient.handle,
    recipientName: recipient.displayName,
    schedule: when.schedule,
    payload: { type: "exact_text", text: message },
    timeZone,
  };
  return { ok: true, plan };
}

export function validatePlan(plan, { ownerHandle, identities } = {}) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return { ok: false, error: "Workflow plan is missing." };
  if (plan.schemaVersion !== 1) return { ok: false, error: "Unsupported workflow schema." };
  if (plan.kind !== "schedule_text" && plan.kind !== "recurring_agent") return { ok: false, error: "Unsupported workflow kind." };
  const recipient = resolveRecipient({ token: plan.recipient ?? plan.recipientName ?? "", ownerHandle, identities });
  if (!recipient.ok) return recipient;
  const schedule = plan.schedule;
  if (!schedule || typeof schedule !== "object") return { ok: false, error: "A schedule is required." };
  if (schedule.type === "at") {
    const at = new Date(schedule.at);
    if (!Number.isFinite(at.getTime())) return { ok: false, error: "The one-shot time is invalid." };
  } else if (schedule.type === "cron") {
    if (!/^\d{1,2} \d{1,2} \* \* (\*|[0-7](?:-[0-7])?)$/u.test(String(schedule.expr ?? ""))) {
      return { ok: false, error: "That cron expression is not a supported Rico schedule." };
    }
  } else {
    return { ok: false, error: "Schedule type must be at or cron." };
  }
  const payload = plan.payload;
  if (payload?.type === "exact_text") {
    const text = String(payload.text ?? "").trim();
    if (!text || text.length > 1000) return { ok: false, error: "The scheduled text must be 1 to 1000 characters." };
  } else if (payload?.type === "agent_turn") {
    const prompt = String(payload.prompt ?? "").trim();
    if (!prompt || prompt.length > 4000) return { ok: false, error: "The agent prompt must be 1 to 4000 characters." };
  } else {
    return { ok: false, error: "Payload must be exact_text or agent_turn." };
  }
  return {
    ok: true,
    plan: {
      schemaVersion: 1,
      kind: plan.kind,
      name: String(plan.name ?? buildName({ recipient: recipient.handle, when: schedule.expr ?? schedule.at })).slice(0, 80),
      recipient: recipient.handle,
      recipientName: recipient.displayName,
      schedule: {
        type: schedule.type,
        ...(schedule.type === "at" ? { at: new Date(schedule.at).toISOString(), deleteAfterRun: true } : {
          expr: schedule.expr,
          tz: schedule.tz || TIME_ZONE,
          deleteAfterRun: false,
        }),
      },
      payload: payload.type === "exact_text"
        ? { type: "exact_text", text: String(payload.text).trim() }
        : { type: "agent_turn", prompt: String(payload.prompt).trim() },
      timeZone: TIME_ZONE,
    },
  };
}

export { TIME_ZONE };
