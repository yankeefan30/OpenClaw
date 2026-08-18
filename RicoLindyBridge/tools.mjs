import { NativeOutlookAdapter } from "../RicoEmailGovernance/native-outlook-adapter.mjs";
import { authorizeEmailRecipient, loadEmailAuthorizations } from "../RicoIMessageMCP/email-allowlist.mjs";
import { loadPolicy } from "../RicoIMessageMCP/allowlist.mjs";
import {
  DEFAULT_CALENDAR_DAYS,
  MAX_CALENDAR_NOTES_CHARS,
  MAX_CALENDAR_TITLE_CHARS,
  MAX_INBOX_ITEMS,
  MAX_MAIL_BODY_CHARS,
  MAX_SUBJECT_CHARS,
  defaultEmailAuthorizationPath,
  defaultPolicyPath,
  studioSupportDirectory,
} from "../RicoIMessageMCP/constants.mjs";
import { createLocalApps } from "../RicoIMessageMCP/local-apps.mjs";
import { BRIDGE_TOOLS, FORBIDDEN_TOOLS, SERVER_NAME, SERVER_VERSION } from "./constants.mjs";
import { fail } from "./errors.mjs";

export const TOOL_CATALOG = Object.freeze(BRIDGE_TOOLS.map((name) => ({
  name,
  client: name.startsWith("calendar_") ? "calendar" : name === "health" ? "local" : "outlook",
})));

export function isBridgeTool(name) {
  return BRIDGE_TOOLS.includes(name);
}

export function isForbiddenTool(name) {
  return FORBIDDEN_TOOLS.includes(String(name ?? ""));
}

export async function callBridgeTool(runtime, name, args = {}) {
  if (isForbiddenTool(name) || !isBridgeTool(name)) {
    throw fail("tool_not_allowed", "That tool is not on the Lindy local-bridge surface.", { status: 403 });
  }
  const apps = localApps(runtime);
  switch (name) {
    case "health":
      return health(apps);
    case "outlook_list_inbox":
      return apps.outlookListInbox({ limit: args.limit });
    case "outlook_search":
      return outlookSearch(apps, args);
    case "outlook_get":
      return apps.outlookGet({ id: sanitizeMessageId(args.id) });
    case "outlook_draft":
      return outlookDraft(runtime, apps, args);
    case "calendar_names":
      return apps.calendarNames();
    case "mailbox_names":
      return lindyMailboxNames();
    case "calendar_list":
      return apps.calendarList({
        days: args.days ?? DEFAULT_CALENDAR_DAYS,
        calendar: optionalName(args.calendar, "calendar_name_invalid"),
      });
    case "calendar_upsert":
      return calendarUpsert(apps, args);
    default:
      throw fail("tool_not_allowed", "That tool is not on the Lindy local-bridge surface.", { status: 403 });
  }
}

async function health(apps) {
  const [calendar, outlook] = await Promise.all([
    apps.calendarHealth(),
    apps.outlookHealth(),
  ]);
  return {
    ok: outlook.reachable === true && calendar.reachable === true,
    bridge: SERVER_NAME,
    version: SERVER_VERSION,
    speaker: "lindy",
    imessage: "disabled",
    outlook: publicAppHealth(outlook),
    calendar: publicAppHealth(calendar),
  };
}

async function outlookSearch(apps, args) {
  const query = sanitizeQuery(args.query);
  const listed = await apps.outlookListInbox({ limit: args.limit ?? MAX_INBOX_ITEMS });
  const needle = query.toLowerCase();
  const messages = listed.messages.filter((item) => (
    String(item.subject ?? "").toLowerCase().includes(needle)
    || String(item.from ?? "").toLowerCase().includes(needle)
  ));
  return {
    ok: true,
    client: "outlook",
    query,
    total: listed.total,
    truncated: listed.truncated,
    messages,
  };
}

async function outlookDraft(runtime, apps, args) {
  const authorized = authorizeEmailForRuntime(runtime, args);
  if (typeof apps.outlookDraft !== "function") {
    throw fail("outlook_draft_failed", "Outlook draft is unavailable.");
  }
  return apps.outlookDraft({
    to: authorized.email,
    from: authorized.senderAccount,
    subject: sanitizeSubject(args.subject),
    text: sanitizeBody(args.text),
  });
}

function lindyMailboxNames() {
  return {
    ok: true,
    mailboxes: [{ client: "outlook", name: "Inbox", queryTool: "outlook_list_inbox" }],
  };
}

function calendarUpsert(apps, args) {
  return apps.calendarUpsert({
    id: optionalName(args.id, "calendar_id_invalid", 256),
    calendar: requiredName(args.calendar, "calendar_name_invalid", 80),
    title: sanitizeTitle(args.title),
    start: args.start,
    end: args.end,
    notes: args.notes == null || args.notes === "" ? "" : sanitizeNotes(args.notes),
    location: args.location == null || args.location === "" ? "" : requiredName(args.location, "calendar_location_invalid", 160),
  });
}

function authorizeEmailForRuntime(runtime, args) {
  const policy = runtime.policy ?? loadPolicy(runtime.policyPath, runtime.supportDirectory);
  const authorizations = runtime.emailAuthorizations ?? loadEmailAuthorizations(
    runtime.emailAuthorizationPath ?? defaultEmailAuthorizationPath(),
  );
  return authorizeEmailRecipient({
    policy,
    authorizations,
    address: args.to,
    from: args.from,
    requireGovernedOutlook: true,
  });
}

export function createBridgeLocalApps(overrides = {}) {
  return createLocalApps({
    outlookAdapter: new NativeOutlookAdapter({ sendEnabled: false }),
    ...overrides,
  });
}

function localApps(runtime) {
  if (runtime?.localApps) return runtime.localApps;
  return createBridgeLocalApps();
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

function sanitizeMessageId(value) {
  const id = String(value ?? "").trim();
  if (!/^[0-9]{1,18}$/u.test(id)) throw fail("message_id_invalid", "Message id is invalid.");
  return id;
}

function sanitizeQuery(value) {
  const text = String(value ?? "").normalize("NFC").trim();
  if (!text || [...text].length > 80 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw fail("query_invalid", "Search query is invalid.");
  }
  return text;
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

export function defaultRuntimePaths() {
  return {
    policyPath: defaultPolicyPath(),
    supportDirectory: studioSupportDirectory(),
    emailAuthorizationPath: defaultEmailAuthorizationPath(),
  };
}
