import { loadPolicy } from "./allowlist.mjs";
import {
  DEFAULT_CALENDAR_DAYS,
  DEFAULT_MAILBOX_NAME,
  MAX_CALENDAR_DAYS,
  MAX_CALENDAR_EXPORT_EVENTS,
  MAX_CALENDAR_NOTES_CHARS,
  MAX_CALENDAR_TITLE_CHARS,
  MAX_IDEMPOTENCY_CHARS,
  MAX_INBOX_ITEMS,
  MAX_MAIL_BODY_CHARS,
  MAX_MAILBOX_NAME_CHARS,
  MAX_SUBJECT_CHARS,
  SERVER_NAME,
  SERVER_VERSION,
  defaultEmailAuthorizationPath,
} from "./constants.mjs";
import {
  isCvsHealthCalendar,
  isCvsHealthMailAccount,
  pickCvsHealthCalendar,
  pickCvsHealthMailAccount,
  publicCalendar,
  publicMailAccount,
} from "./cvs-health.mjs";
import { authorizeEmailRecipient, loadEmailAuthorizations } from "./email-allowlist.mjs";
import { fail } from "./errors.mjs";
import { createLocalApps } from "./local-apps.mjs";
import { eventsToIcs, notionCvsCalendarTarget, planNotionSync } from "./notion-calendar-sync.mjs";

export const LOCAL_TOOL_DEFINITIONS = Object.freeze([
  {
    name: "rico_local_apps_health",
    description: "Report whether local Mail.app, Calendar.app, and Microsoft Outlook are reachable. Returns no secrets, tokens, or account identifiers.",
    inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "rico_mail_list_accounts",
    description: "List Apple Mail account names on this Mac. Does not return mailbox contents, tokens, or extra email addresses.",
    inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "rico_mail_list_inbox",
    description: "List a bounded number of recent Apple Mail inbox messages (metadata only). Optional account selects one Mail.app account instead of the unified inbox. Not a full mailbox scrape.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: MAX_INBOX_ITEMS, description: "Max messages to return." },
        account: { type: "string", minLength: 1, maxLength: 80, description: "Exact Mail.app account name." },
        mailbox: { type: "string", minLength: 1, maxLength: MAX_MAILBOX_NAME_CHARS, description: "Mailbox name. Defaults to INBOX." },
      },
      required: [],
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "rico_mail_get",
    description: "Get one Apple Mail inbox message by id from a previous list. Body is truncated. Optional account scopes the lookup to that Mail.app account.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string", minLength: 1, maxLength: 32, description: "Mail message id from rico_mail_list_inbox." },
        account: { type: "string", minLength: 1, maxLength: 80, description: "Exact Mail.app account name." },
        mailbox: { type: "string", minLength: 1, maxLength: MAX_MAILBOX_NAME_CHARS, description: "Mailbox name. Defaults to INBOX." },
      },
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "rico_mail_send",
    description: "Send or reply from Apple Mail only to an allowlisted address (Rico person-email authorization, owner account, or recipient-guard email). Strangers are rejected.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["to", "subject", "text"],
      properties: {
        to: { type: "string", minLength: 3, maxLength: 254, description: "Allowlisted recipient email." },
        subject: { type: "string", minLength: 1, maxLength: MAX_SUBJECT_CHARS },
        text: { type: "string", minLength: 1, maxLength: MAX_MAIL_BODY_CHARS },
        replyToId: { type: "string", minLength: 1, maxLength: 32, description: "Optional inbox message id to reply to." },
      },
    },
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "rico_calendar_list_calendars",
    description: "List Calendar.app (iCal) calendar names on this Mac, including the account/source when EventKit can provide it.",
    inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "rico_calendar_list",
    description: "List upcoming Calendar.app events in a bounded window. Optional calendar and account names limit the search to one iCal calendar.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        days: { type: "integer", minimum: 1, maximum: MAX_CALENDAR_DAYS, description: "Forward window in days." },
        calendar: { type: "string", minLength: 1, maxLength: 80, description: "Exact local calendar name." },
        account: { type: "string", minLength: 1, maxLength: 80, description: "Exact Calendar account/source name." },
      },
      required: [],
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "rico_calendar_export_notion",
    description: "Export upcoming CVS Health Calendar.app (iCal) events as Notion page payloads for the CVS Health Calendar database, plus a local ICS body. Does not write to Notion or copy events to personal Google/iCloud calendars.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        days: { type: "integer", minimum: 1, maximum: MAX_CALENDAR_DAYS, description: "Forward window in days." },
        calendar: { type: "string", minLength: 1, maxLength: 80, description: "Exact local calendar name." },
        account: { type: "string", minLength: 1, maxLength: 80, description: "Exact Calendar account/source name." },
      },
      required: [],
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "rico_calendar_upsert",
    description: "Create or update one local Calendar.app event on a specified calendar. No attendees are invited.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["calendar", "title", "start", "end"],
      properties: {
        id: { type: "string", minLength: 1, maxLength: 256, description: "Existing event uid to update." },
        calendar: { type: "string", minLength: 1, maxLength: 80, description: "Exact local calendar name." },
        account: { type: "string", minLength: 1, maxLength: 80, description: "Exact Calendar account/source name." },
        title: { type: "string", minLength: 1, maxLength: MAX_CALENDAR_TITLE_CHARS },
        start: { type: "string", minLength: 10, maxLength: 40, description: "ISO-8601 start." },
        end: { type: "string", minLength: 10, maxLength: 40, description: "ISO-8601 end." },
        notes: { type: "string", maxLength: MAX_CALENDAR_NOTES_CHARS },
        location: { type: "string", maxLength: 160 },
      },
    },
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "rico_outlook_list_inbox",
    description: "List a bounded number of recent Microsoft Outlook inbox messages (metadata only) on this Mac. Fails clearly if Outlook is missing.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: MAX_INBOX_ITEMS },
      },
      required: [],
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "rico_outlook_get",
    description: "Get one Outlook inbox message by id from a previous list. Body is truncated. Fails clearly if Outlook is missing.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string", minLength: 1, maxLength: 32, description: "Outlook message id from rico_outlook_list_inbox." },
      },
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "rico_outlook_send",
    description: "Send one governed Outlook email to a Rico-authorized person or owner account. Reuses Outlook-only person-email policy. Strangers are rejected. Fails clearly if Outlook is missing.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["to", "subject", "text"],
      properties: {
        to: { type: "string", minLength: 3, maxLength: 254, description: "Governed recipient email." },
        from: { type: "string", minLength: 3, maxLength: 254, description: "Approved Rico Outlook sender account." },
        subject: { type: "string", minLength: 1, maxLength: MAX_SUBJECT_CHARS },
        text: { type: "string", minLength: 1, maxLength: MAX_MAIL_BODY_CHARS },
        idempotencyKey: { type: "string", minLength: 1, maxLength: MAX_IDEMPOTENCY_CHARS },
      },
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
]);

const LOCAL_TOOL_NAMES = new Set(LOCAL_TOOL_DEFINITIONS.map((tool) => tool.name));

export const NOTION_TOOL_NAMES = Object.freeze([
  "rico_local_apps_health",
  "rico_mail_list_accounts",
  "rico_mail_list_inbox",
  "rico_mail_get",
  "rico_calendar_list_calendars",
  "rico_calendar_list",
  "rico_calendar_export_notion",
  "rico_calendar_upsert",
]);

export const NOTION_TOOL_DEFINITIONS = Object.freeze(
  LOCAL_TOOL_DEFINITIONS.filter((tool) => NOTION_TOOL_NAMES.includes(tool.name)),
);

export function isLocalTool(name) {
  return LOCAL_TOOL_NAMES.has(name);
}

export function isNotionTool(name) {
  return NOTION_TOOL_NAMES.includes(name);
}

export async function callLocalTool(runtime, name, args, { profile = "full" } = {}) {
  if (profile === "notion-cvs" && !isNotionTool(name)) {
    throw fail("tool_not_found", "Unknown Rico Notion tool.");
  }
  const apps = localApps(runtime);
  const scoped = profile === "notion-cvs" ? await withCvsHealthScope(apps, name, args) : args;
  switch (name) {
    case "rico_local_apps_health":
      return localAppsHealth(apps, { profile, scoped });
    case "rico_mail_list_accounts":
      return mailListAccounts(apps, { profile });
    case "rico_mail_list_inbox":
      return apps.mailListInbox({
        limit: scoped?.limit,
        account: optionalName(scoped?.account, "mail_account_invalid"),
        mailbox: optionalName(scoped?.mailbox, "mail_mailbox_invalid") ?? (scoped?.account ? DEFAULT_MAILBOX_NAME : undefined),
      });
    case "rico_mail_get":
      return apps.mailGet({
        id: sanitizeMessageId(scoped?.id),
        account: optionalName(scoped?.account, "mail_account_invalid"),
        mailbox: optionalName(scoped?.mailbox, "mail_mailbox_invalid"),
      });
    case "rico_mail_send":
      return mailSend(runtime, apps, scoped);
    case "rico_calendar_list_calendars":
      return calendarListCalendars(apps, { profile });
    case "rico_calendar_list":
      return apps.calendarList({
        days: scoped?.days ?? DEFAULT_CALENDAR_DAYS,
        calendar: optionalName(scoped?.calendar, "calendar_name_invalid"),
        account: optionalName(scoped?.account, "calendar_account_invalid"),
      });
    case "rico_calendar_export_notion":
      return calendarExportNotion(apps, scoped);
    case "rico_calendar_upsert":
      return calendarUpsert(apps, scoped);
    case "rico_outlook_list_inbox":
      return apps.outlookListInbox({ limit: scoped?.limit });
    case "rico_outlook_get":
      return apps.outlookGet({ id: sanitizeMessageId(scoped?.id) });
    case "rico_outlook_send":
      return outlookSend(runtime, apps, scoped);
    default:
      throw fail("tool_not_found", "Unknown Rico local-app tool.");
  }
}

async function localAppsHealth(apps, { profile = "full", scoped } = {}) {
  const [mail, calendar, outlook] = await Promise.all([
    apps.mailHealth(),
    apps.calendarHealth(),
    apps.outlookHealth(),
  ]);
  const result = {
    ok: mail.reachable === true && calendar.reachable === true,
    bridge: SERVER_NAME,
    version: SERVER_VERSION,
    mail: publicAppHealth(mail),
    calendar: publicAppHealth(calendar),
    outlook: publicAppHealth(outlook),
  };
  if (profile === "notion-cvs") {
    result.profile = "notion-cvs";
    result.mail = {
      ...result.mail,
      cvsHealth: Boolean(scoped?.mailAccount),
      account: scoped?.mailAccount?.name,
    };
    result.calendar = {
      ...result.calendar,
      cvsHealth: Boolean(scoped?.calendar),
      calendar: scoped?.calendar?.name,
      account: scoped?.calendar?.account || undefined,
    };
    result.ok = result.ok && result.mail.cvsHealth === true && result.calendar.cvsHealth === true;
    if (!result.mail.cvsHealth) result.mail.error = result.mail.error || "cvs_health_mail_not_found";
    if (!result.calendar.cvsHealth) result.calendar.error = result.calendar.error || "cvs_health_calendar_not_found";
  }
  return result;
}

async function mailListAccounts(apps, { profile = "full" } = {}) {
  const listed = await apps.mailListAccounts();
  let accounts = listed.accounts.map(publicMailAccount);
  if (profile === "notion-cvs") accounts = accounts.filter((account) => account.cvsHealth);
  return { ok: true, client: "mail", total: accounts.length, accounts };
}

async function calendarListCalendars(apps, { profile = "full" } = {}) {
  const listed = await apps.calendarListCalendars();
  let calendars = listed.calendars.map(publicCalendar);
  if (profile === "notion-cvs") calendars = calendars.filter((calendar) => calendar.cvsHealth);
  return { ok: true, client: "calendar", total: calendars.length, calendars };
}

async function withCvsHealthScope(apps, name, args) {
  if (name === "rico_local_apps_health") {
    const [accounts, calendars] = await Promise.all([
      apps.mailListAccounts(),
      apps.calendarListCalendars(),
    ]);
    return {
      ...args,
      mailAccount: pickCvsHealthMailAccount(accounts.accounts),
      calendar: pickCvsHealthCalendar(calendars.calendars),
    };
  }
  if (name === "rico_mail_list_inbox" || name === "rico_mail_get") {
    const listed = await apps.mailListAccounts();
    const requested = optionalName(args?.account, "mail_account_invalid");
    const account = requested
      ? listed.accounts.find((item) => item.name === requested)
      : pickCvsHealthMailAccount(listed.accounts);
    if (!account || !isCvsHealthMailAccount(account)) {
      throw fail("cvs_health_mail_not_found", "The CVS Health Mail.app account was not found.");
    }
    return {
      ...args,
      account: account.name,
      mailbox: optionalName(args?.mailbox, "mail_mailbox_invalid") ?? DEFAULT_MAILBOX_NAME,
    };
  }
  if (name === "rico_calendar_list" || name === "rico_calendar_export_notion" || name === "rico_calendar_upsert") {
    const listed = await apps.calendarListCalendars();
    const requestedName = optionalName(args?.calendar, "calendar_name_invalid");
    const requestedAccount = optionalName(args?.account, "calendar_account_invalid");
    const allowed = listed.calendars.filter(isCvsHealthCalendar);
    let calendar = requestedName
      ? allowed.find((item) => item.name === requestedName && (!requestedAccount || !item.account || item.account === requestedAccount))
      : pickCvsHealthCalendar(listed.calendars);
    if (!calendar) {
      throw fail("cvs_health_calendar_not_found", "The CVS Health Calendar.app calendar was not found.");
    }
    return {
      ...args,
      calendar: calendar.name,
      account: requestedAccount || calendar.account || undefined,
    };
  }
  return args ?? {};
}

function publicAppHealth(result) {
  const health = {
    installed: result.installed === true,
    reachable: result.reachable === true,
  };
  if (result.configured !== undefined) health.configured = result.configured === true;
  if (typeof result.inboxCount === "number") health.inboxCount = result.inboxCount;
  if (typeof result.calendarCount === "number") health.calendarCount = result.calendarCount;
  if (result.error) health.error = String(result.error).slice(0, 80);
  return health;
}

async function mailSend(runtime, apps, args) {
  const authorized = authorizeEmailForRuntime(runtime, args, { requireGovernedOutlook: false });
  const subject = sanitizeSubject(args?.subject);
  const text = sanitizeBody(args?.text);
  const replyToId = args?.replyToId ? sanitizeMessageId(args.replyToId) : undefined;
  return apps.mailSend({ to: authorized.email, subject, text, replyToId });
}

async function outlookSend(runtime, apps, args) {
  const authorized = authorizeEmailForRuntime(runtime, args, { requireGovernedOutlook: true });
  return apps.outlookSend({
    to: authorized.email,
    from: authorized.senderAccount,
    subject: sanitizeSubject(args?.subject),
    text: sanitizeBody(args?.text),
    idempotencyKey: sanitizeIdempotency(args?.idempotencyKey),
  });
}

async function calendarExportNotion(apps, args) {
  const listed = await apps.calendarList({
    days: args?.days ?? DEFAULT_CALENDAR_DAYS,
    calendar: optionalName(args?.calendar, "calendar_name_invalid"),
    account: optionalName(args?.account, "calendar_account_invalid"),
    limit: MAX_CALENDAR_EXPORT_EVENTS,
  });
  const planned = planNotionSync({
    events: listed.events,
    account: listed.account || "CVS Health",
  });
  return {
    ok: true,
    client: "calendar",
    windowDays: listed.windowDays,
    calendar: listed.calendar,
    account: listed.account,
    truncated: listed.truncated === true,
    target: notionCvsCalendarTarget(),
    creates: planned.creates,
    ics: eventsToIcs(listed.events, { calendarName: listed.calendar || "CVS Health" }),
    copyToPersonalCalendars: false,
  };
}

function calendarUpsert(apps, args) {
  return apps.calendarUpsert({
    id: optionalName(args?.id, "calendar_id_invalid", 256),
    calendar: requiredName(args?.calendar, "calendar_name_invalid", 80),
    account: optionalName(args?.account, "calendar_account_invalid"),
    title: sanitizeTitle(args?.title),
    start: args?.start,
    end: args?.end,
    notes: args?.notes == null || args.notes === "" ? "" : sanitizeNotes(args.notes),
    location: args?.location == null || args.location === "" ? "" : requiredName(args.location, "calendar_location_invalid", 160),
  });
}

function authorizeEmailForRuntime(runtime, args, { requireGovernedOutlook }) {
  const policy = runtime.policy ?? loadPolicy(runtime.policyPath, runtime.supportDirectory);
  const authorizations = runtime.emailAuthorizations ?? loadEmailAuthorizations(
    runtime.emailAuthorizationPath ?? defaultEmailAuthorizationPath(),
  );
  return authorizeEmailRecipient({
    policy,
    authorizations,
    address: args?.to,
    from: args?.from,
    requireGovernedOutlook,
  });
}

function localApps(runtime) {
  if (runtime?.localApps) return runtime.localApps;
  return createLocalApps();
}

function sanitizeMessageId(value) {
  const id = String(value ?? "").trim();
  if (!/^[0-9]{1,18}$/u.test(id)) throw fail("message_id_invalid", "Message id is invalid.");
  return id;
}

function sanitizeSubject(value) {
  return sanitizeLine(value, MAX_SUBJECT_CHARS, "subject_invalid", "Subject is required.");
}

function sanitizeTitle(value) {
  return sanitizeLine(value, MAX_CALENDAR_TITLE_CHARS, "calendar_title_invalid", "Event title is required.");
}

function sanitizeNotes(value) {
  return sanitizeMultiline(value, MAX_CALENDAR_NOTES_CHARS, "calendar_notes_invalid");
}

function sanitizeBody(value) {
  return sanitizeMultiline(value, MAX_MAIL_BODY_CHARS, "text_invalid");
}

function sanitizeLine(value, maxChars, code, emptyMessage) {
  const text = String(value ?? "").normalize("NFC").replace(/\r\n/gu, "\n").trim();
  if (!text) throw fail(code, emptyMessage);
  if ([...text].length > maxChars || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) || /\n/.test(text)) {
    throw fail(code, emptyMessage);
  }
  return text;
}

function sanitizeMultiline(value, maxChars, code) {
  const text = String(value ?? "").normalize("NFC").replace(/\r\n/gu, "\n");
  if (!text.trim()) throw fail(code, "Message text is required.");
  if ([...text].length > maxChars || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw fail(code, "Message text is invalid.");
  }
  return text;
}

function requiredName(value, code, maxChars) {
  const text = String(value ?? "").normalize("NFC").trim();
  if (!text || [...text].length > maxChars || /[\u0000-\u001f\u007f]/.test(text)) {
    throw fail(code, "Name is invalid.");
  }
  return text;
}

function optionalName(value, code, maxChars = 80) {
  if (value == null || value === "") return undefined;
  return requiredName(value, code, maxChars);
}

function sanitizeIdempotency(value) {
  if (value == null || value === "") return `rico-outlook-mcp-${Date.now()}`;
  const key = String(value).trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) {
    throw fail("idempotency_invalid", "idempotencyKey must be 1-128 URL-safe characters.");
  }
  return key;
}
