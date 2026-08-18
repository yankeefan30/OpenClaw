import fs from "node:fs";
import path from "node:path";
import { NativeOutlookAdapter, assertInstalledOutlook, runOutlookAppleScript } from "../RicoEmailGovernance/native-outlook-adapter.mjs";
import { OUTLOOK_BUNDLE_ID, OUTLOOK_CLIENT } from "../RicoEmailGovernance/definition.mjs";
import { appleScriptString, clipText, parseOkRecords, runOsascript } from "./applescript.mjs";
import {
  CALENDAR_BUNDLE_ID,
  DEFAULT_CALENDAR_APP_PATH,
  DEFAULT_CALENDAR_DAYS,
  DEFAULT_MAIL_APP_PATH,
  DEFAULT_OUTLOOK_APP_PATH,
  MAIL_BUNDLE_ID,
  MAX_CALENDAR_EVENTS,
  MAX_CALENDAR_NOTES_CHARS,
  MAX_CALENDAR_TITLE_CHARS,
  MAX_EVENT_DURATION_DAYS,
  MAX_INBOX_ITEMS,
  MAX_MAIL_BODY_CHARS,
  MAX_SUBJECT_CHARS,
} from "./constants.mjs";
import { fail } from "./errors.mjs";

const MAIL_APP = "Mail";
const CALENDAR_APP = "Calendar";

export function createLocalApps({
  runner = runOsascript,
  outlookAdapter,
  outlookRunner = runOutlookAppleScript,
  outlookAppPath = DEFAULT_OUTLOOK_APP_PATH,
  mailAppPath = DEFAULT_MAIL_APP_PATH,
  calendarAppPath = DEFAULT_CALENDAR_APP_PATH,
  now = () => new Date(),
} = {}) {
  const outlook = outlookAdapter ?? new NativeOutlookAdapter({
    runner: outlookRunner,
    appPath: outlookAppPath,
    sendEnabled: true,
  });

  return {
    async mailHealth() {
      return appHealth({
        name: "mail",
        installed: appInstalled(mailAppPath),
        probe: () => runner(mailHealthScript()),
        parse: (output) => ({ inboxCount: Number(String(output).split("\n")[1] ?? 0) || 0 }),
      });
    },

    async mailListInbox({ limit = MAX_INBOX_ITEMS } = {}) {
      const n = boundedLimit(limit);
      const output = await runApp(runner, mailListScript(n), "mail");
      const parsed = parseOkRecords(output, 4);
      return {
        ok: true,
        client: "mail",
        total: parsed.total,
        truncated: parsed.total > parsed.rows.length,
        messages: parsed.rows.map(([id, subject, from, date]) => ({
          id,
          subject: clipText(subject, MAX_SUBJECT_CHARS),
          from,
          date,
        })),
      };
    },

    async mailGet({ id }) {
      const output = await runApp(runner, mailGetScript(id), "mail");
      const parsed = parseOkRecords(output, 5);
      if (parsed.rows.length !== 1) throw fail("mail_not_found", "That Mail message was not found in the inbox.");
      const [messageId, subject, from, date, body] = parsed.rows[0];
      return {
        ok: true,
        client: "mail",
        message: {
          id: messageId,
          subject: clipText(subject, MAX_SUBJECT_CHARS),
          from,
          date,
          body: clipText(body, MAX_MAIL_BODY_CHARS),
        },
      };
    },

    async mailSend({ to, subject, text, replyToId }) {
      const output = await runApp(runner, mailSendScript({ to, subject, text, replyToId }), "mail", 30_000);
      if (!String(output).startsWith("RICO_OK")) {
        throw fail("mail_send_failed", "Mail.app did not confirm the send.");
      }
      return { ok: true, client: "mail", to, subject };
    },

    async calendarHealth() {
      return appHealth({
        name: "calendar",
        installed: appInstalled(calendarAppPath),
        probe: () => runner(calendarHealthScript()),
        parse: (output) => ({ calendarCount: Number(String(output).split("\n")[1] ?? 0) || 0 }),
      });
    },

    async calendarNames() {
      const output = await runApp(runner, calendarNamesScript(), "calendar", 20_000);
      const parsed = parseOkRecords(output, 1);
      return {
        ok: true,
        client: "calendar",
        calendars: parsed.rows.map(([name]) => ({ name: clipText(name, 80) })),
      };
    },

    async mailboxNames() {
      const mailboxes = [{ client: "mail", name: "Inbox", queryTool: "rico_mail_list_inbox" }];
      if (await outlookIsInstalled(outlookAppPath)) {
        mailboxes.push({ client: "outlook", name: "Inbox", queryTool: "rico_outlook_list_inbox" });
      }
      return { ok: true, mailboxes };
    },

    async calendarList({ days = DEFAULT_CALENDAR_DAYS, calendar } = {}) {
      const windowDays = boundedDays(days);
      const start = now();
      const end = new Date(start.getTime() + windowDays * 86_400_000);
      const output = await runApp(runner, calendarListScript({
        start: dateParts(start),
        end: dateParts(end),
        calendar: calendar ?? "",
        limit: MAX_CALENDAR_EVENTS,
      }), "calendar", 20_000);
      const parsed = parseOkRecords(output, 6);
      return {
        ok: true,
        client: "calendar",
        windowDays,
        truncated: parsed.total > parsed.rows.length,
        events: parsed.rows.map(([id, calendarName, title, eventStart, eventEnd, location]) => ({
          id,
          calendar: calendarName,
          title: clipText(title, MAX_CALENDAR_TITLE_CHARS),
          start: eventStart,
          end: eventEnd,
          location: clipText(location, 160),
        })),
      };
    },

    async calendarUpsert({ id, calendar, title, start, end, notes, location }) {
      const startDate = requireDate(start, "calendar_start_invalid");
      const endDate = requireDate(end, "calendar_end_invalid");
      if (endDate.getTime() <= startDate.getTime()) {
        throw fail("calendar_range_invalid", "Event end must be after start.");
      }
      if (endDate.getTime() - startDate.getTime() > MAX_EVENT_DURATION_DAYS * 86_400_000) {
        throw fail("calendar_range_invalid", "Event duration is too long.");
      }
      const output = await runApp(runner, calendarUpsertScript({
        id: id ?? "",
        calendar,
        title,
        start: dateParts(startDate),
        end: dateParts(endDate),
        notes: notes ?? "",
        location: location ?? "",
      }), "calendar", 20_000);
      const lines = String(output).split("\n");
      if (lines[0] !== "RICO_OK" || !lines[1]) {
        throw fail("calendar_write_failed", "Calendar.app did not confirm the event.");
      }
      return {
        ok: true,
        client: "calendar",
        id: lines[1],
        calendar,
        title,
        start: startDate.toISOString(),
        end: endDate.toISOString(),
        created: !id,
      };
    },

    async outlookHealth() {
      const installed = await outlookIsInstalled(outlookAppPath);
      if (!installed) {
        return { name: "outlook", installed: false, reachable: false, configured: false, error: "outlook_not_installed" };
      }
      let reachable = false;
      let inboxCount;
      try {
        const output = await runner(outlookHealthScript());
        if (String(output).startsWith("RICO_OK")) {
          reachable = true;
          inboxCount = Number(String(output).split("\n")[1] ?? 0) || 0;
        }
      } catch (error) {
        if (error?.code === "automation_denied") {
          return { name: "outlook", installed: true, reachable: false, configured: false, error: "automation_denied" };
        }
      }
      let configured = false;
      let configuredError;
      try {
        const proof = await outlook.health();
        configured = proof?.ok === true;
        if (!configured) configuredError = mapOutlookHealthError(proof?.errorCode);
      } catch (error) {
        configuredError = mapOutlookHealthError(error?.code);
      }
      const result = { name: "outlook", installed: true, reachable, configured };
      if (typeof inboxCount === "number") result.inboxCount = inboxCount;
      if (!reachable) result.error = configuredError === "automation_denied" ? "automation_denied" : "outlook_unreachable";
      else if (!configured) result.error = configuredError || "outlook_not_configured";
      return result;
    },

    async outlookListInbox({ limit = MAX_INBOX_ITEMS } = {}) {
      await requireOutlook(outlookAppPath);
      const n = boundedLimit(limit);
      const output = await runApp(runner, outlookListScript(n), "outlook");
      const parsed = parseOkRecords(output, 4);
      return {
        ok: true,
        client: "outlook",
        total: parsed.total,
        truncated: parsed.total > parsed.rows.length,
        messages: parsed.rows.map(([id, subject, from, date]) => ({
          id,
          subject: clipText(subject, MAX_SUBJECT_CHARS),
          from,
          date,
        })),
      };
    },

    async outlookGet({ id }) {
      await requireOutlook(outlookAppPath);
      const output = await runApp(runner, outlookGetScript(id), "outlook");
      const parsed = parseOkRecords(output, 5);
      if (parsed.rows.length !== 1) throw fail("outlook_not_found", "That Outlook message was not found in the inbox.");
      const [messageId, subject, from, date, body] = parsed.rows[0];
      return {
        ok: true,
        client: "outlook",
        message: {
          id: messageId,
          subject: clipText(subject, MAX_SUBJECT_CHARS),
          from,
          date,
          body: clipText(body, MAX_MAIL_BODY_CHARS),
        },
      };
    },

    async outlookDraft({ to, from, subject, text }) {
      await requireOutlook(outlookAppPath);
      const output = await runApp(runner, outlookDraftScript({ to, from, subject, text }), "outlook", 30_000);
      const lines = String(output).split("\n");
      if (lines[0] !== "RICO_OK" || !lines[1]) {
        throw fail("outlook_draft_failed", "Outlook did not confirm the draft.");
      }
      return {
        ok: true,
        client: "outlook",
        drafted: true,
        sent: false,
        id: lines[1],
        to,
        from,
        subject,
      };
    },

    async outlookSend(request) {
      await requireOutlook(outlookAppPath);
      try {
        const result = await outlook.sendEmail({
          client: OUTLOOK_CLIENT,
          clientBundleId: OUTLOOK_BUNDLE_ID,
          senderAccount: request.from,
          recipient: request.to,
          subject: request.subject,
          text: request.text,
          attachments: [],
          idempotencyKey: request.idempotencyKey,
          requireSourceAccountProof: true,
          noSenderFallback: true,
        });
        return {
          ok: true,
          client: "outlook",
          to: request.to,
          from: result.from,
          messageId: result.messageId,
        };
      } catch (error) {
        throw mapOutlookSendError(error);
      }
    },
  };
}

async function appHealth({ name, installed, probe, parse }) {
  if (!installed) {
    return { name, installed: false, reachable: false, error: `${name}_not_installed` };
  }
  try {
    const output = await probe();
    if (!String(output).startsWith("RICO_OK")) {
      return { name, installed: true, reachable: false, error: `${name}_unreachable` };
    }
    return { name, installed: true, reachable: true, ...parse(output) };
  } catch (error) {
    return {
      name,
      installed: true,
      reachable: false,
      error: error?.code === "automation_denied" ? "automation_denied" : `${name}_unreachable`,
    };
  }
}

async function runApp(runner, script, app, timeoutMs) {
  try {
    return await runner(script, timeoutMs ? { timeoutMs } : undefined);
  } catch (error) {
    if (error?.code === "automation_denied") {
      throw fail("automation_denied", `macOS Automation permission is required for ${appLabel(app)}. Allow node to control it, then retry.`);
    }
    if (error?.code === "mail_not_found") {
      throw fail("mail_not_found", "That Mail message was not found in the inbox.");
    }
    if (error?.code === "calendar_not_found") {
      throw fail("calendar_not_found", "That Calendar event was not found.");
    }
    if (error?.code === "local_app_timeout" || error?.code === "automation_output_too_large" || error?.code === "automation_unavailable") {
      throw error;
    }
    throw fail(`${app}_unavailable`, `${appLabel(app)} is not reachable.`);
  }
}

function appLabel(app) {
  if (app === "mail") return "Mail.app";
  if (app === "calendar") return "Calendar.app";
  return "Microsoft Outlook";
}

function appInstalled(appPath) {
  try {
    const stat = fs.lstatSync(path.resolve(appPath));
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

async function outlookIsInstalled(appPath) {
  try {
    await assertInstalledOutlook(appPath);
    return true;
  } catch {
    return false;
  }
}

async function requireOutlook(appPath) {
  if (!await outlookIsInstalled(appPath)) {
    throw fail("outlook_not_installed", "Microsoft Outlook is not installed on this Mac.");
  }
}

function mapOutlookHealthError(code) {
  const value = String(code ?? "");
  if (value.includes("automation_denied")) return "automation_denied";
  if (value.includes("not_installed") || value.includes("app_invalid") || value.includes("bundle_mismatch")) {
    return "outlook_not_installed";
  }
  return "outlook_not_configured";
}

function mapOutlookSendError(error) {
  const code = String(error?.code ?? "");
  if (code === "native_outlook_send_disabled") {
    return fail("outlook_send_disabled", "Governed Outlook send is disabled.");
  }
  if (code === "native_outlook_automation_denied") {
    return fail("automation_denied", "macOS Automation permission is required for Microsoft Outlook. Allow node to control it, then retry.");
  }
  if (code.includes("not_installed") || code.includes("app_invalid") || code.includes("bundle_mismatch")) {
    return fail("outlook_not_installed", "Microsoft Outlook is not installed on this Mac.");
  }
  if (code.includes("account") || code.includes("unproven") || code.includes("offline") || code.includes("not_send_capable")) {
    return fail("outlook_not_configured", "Microsoft Outlook is installed but the governed account is not ready.");
  }
  return fail("outlook_send_failed", "Outlook did not confirm the send.");
}

function boundedLimit(limit) {
  const value = Number(limit);
  if (!Number.isInteger(value) || value < 1) return MAX_INBOX_ITEMS;
  return Math.min(value, MAX_INBOX_ITEMS);
}

function boundedDays(days) {
  const value = Number(days);
  if (!Number.isInteger(value) || value < 1) return DEFAULT_CALENDAR_DAYS;
  return Math.min(value, 14);
}

function requireDate(value, code) {
  const date = new Date(String(value ?? ""));
  if (!Number.isFinite(date.getTime())) throw fail(code, "Date must be ISO-8601.");
  return date;
}

function dateParts(date) {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hours: date.getHours(),
    minutes: date.getMinutes(),
    seconds: date.getSeconds(),
  };
}

function helpersScript() {
  return `on clipText(theText, maxLen)
set s to my oneLine(theText)
if (count of s) > maxLen then return text 1 thru maxLen of s
return s
end clipText

on oneLine(theText)
set s to theText as text
set AppleScript's text item delimiters to {return, linefeed, character id 30, character id 31}
set bits to text items of s
set AppleScript's text item delimiters to " "
return bits as text
end oneLine

on isoDate(theDate)
try
return (theDate as «class isot») as string
on error
return theDate as text
end try
end isoDate

on makeDate(y, mo, d, h, mi, s)
set theDate to current date
set year of theDate to y
set month of theDate to mo
set day of theDate to d
set hours of theDate to h
set minutes of theDate to mi
set seconds of theDate to s
return theDate
end makeDate
`;
}

function mailHealthScript() {
  return `tell application "${MAIL_APP}"
return "RICO_OK" & linefeed & (count of messages of inbox as text)
end tell`;
}

function mailListScript(limit) {
  return `${helpersScript()}
tell application "${MAIL_APP}"
set total to count of messages of inbox
set n to ${limit}
if total < n then set n to total
set rows to {}
repeat with i from 1 to n
set m to message i of inbox
set end of rows to (id of m as text) & (character id 31) & my clipText(subject of m as text, ${MAX_SUBJECT_CHARS}) & (character id 31) & my clipText(sender of m as text, 254) & (character id 31) & my isoDate(date received of m)
end repeat
set AppleScript's text item delimiters to character id 30
return "RICO_OK" & linefeed & (total as text) & linefeed & (n as text) & linefeed & (rows as text)
end tell`;
}

function mailGetScript(id) {
  return `${helpersScript()}
tell application "${MAIL_APP}"
set matches to (messages of inbox whose id is ${appleScriptNumber(id)})
if (count of matches) is not 1 then error "RICO_MAIL_NOT_FOUND" number 7301
set m to item 1 of matches
set row to (id of m as text) & (character id 31) & my clipText(subject of m as text, ${MAX_SUBJECT_CHARS}) & (character id 31) & my clipText(sender of m as text, 254) & (character id 31) & my isoDate(date received of m) & (character id 31) & my clipText(content of m as text, ${MAX_MAIL_BODY_CHARS})
return "RICO_OK" & linefeed & "1" & linefeed & "1" & linefeed & row
end tell`;
}

function mailSendScript({ to, subject, text, replyToId }) {
  if (replyToId) {
    return `tell application "${MAIL_APP}"
set matches to (messages of inbox whose id is ${appleScriptNumber(replyToId)})
if (count of matches) is not 1 then error "RICO_MAIL_NOT_FOUND" number 7301
set theReply to reply (item 1 of matches) without opening window
set content of theReply to ${appleScriptString(text)}
send theReply
return "RICO_OK"
end tell`;
  }
  return `tell application "${MAIL_APP}"
set newMessage to make new outgoing message with properties {subject:${appleScriptString(subject)}, content:${appleScriptString(text)}, visible:false}
tell newMessage
make new to recipient at end of to recipients with properties {address:${appleScriptString(to)}}
end tell
send newMessage
return "RICO_OK"
end tell`;
}

function calendarHealthScript() {
  return `tell application "${CALENDAR_APP}"
return "RICO_OK" & linefeed & (count of calendars as text)
end tell`;
}

function calendarNamesScript() {
  return `${helpersScript()}
tell application "${CALENDAR_APP}"
set rows to {}
repeat with cal in calendars
set end of rows to my clipText(name of cal as text, 80)
end repeat
set AppleScript's text item delimiters to character id 30
return "RICO_OK" & linefeed & ((count of rows) as text) & linefeed & ((count of rows) as text) & linefeed & (rows as text)
end tell`;
}

function calendarListScript({ start, end, calendar, limit }) {
  const calendarFilter = calendar
    ? `if (name of cal as text) is ${appleScriptString(calendar)} then`
    : "if true then";
  return `${helpersScript()}
set startDate to my makeDate(${start.year}, ${start.month}, ${start.day}, ${start.hours}, ${start.minutes}, ${start.seconds})
set endDate to my makeDate(${end.year}, ${end.month}, ${end.day}, ${end.hours}, ${end.minutes}, ${end.seconds})
tell application "${CALENDAR_APP}"
set rows to {}
set taken to 0
set seen to 0
repeat with cal in calendars
${calendarFilter}
set evs to (every event of cal whose start date ≥ startDate and start date < endDate)
set seen to seen + (count of evs)
repeat with ev in evs
if taken ≥ ${limit} then exit repeat
set loc to ""
try
set loc to location of ev as text
end try
set end of rows to (uid of ev as text) & (character id 31) & my clipText(name of cal as text, 80) & (character id 31) & my clipText(summary of ev as text, ${MAX_CALENDAR_TITLE_CHARS}) & (character id 31) & my isoDate(start date of ev) & (character id 31) & my isoDate(end date of ev) & (character id 31) & my clipText(loc, 160)
set taken to taken + 1
end repeat
end if
if taken ≥ ${limit} then exit repeat
end repeat
set AppleScript's text item delimiters to character id 30
return "RICO_OK" & linefeed & (seen as text) & linefeed & (taken as text) & linefeed & (rows as text)
end tell`;
}

function calendarUpsertScript({ id, calendar, title, start, end, notes, location }) {
  const createProps = `{summary:${appleScriptString(title)}, start date:startDate, end date:endDate, description:${appleScriptString(notes)}, location:${appleScriptString(location)}}`;
  if (id) {
    return `${helpersScript()}
set startDate to my makeDate(${start.year}, ${start.month}, ${start.day}, ${start.hours}, ${start.minutes}, ${start.seconds})
set endDate to my makeDate(${end.year}, ${end.month}, ${end.day}, ${end.hours}, ${end.minutes}, ${end.seconds})
tell application "${CALENDAR_APP}"
tell calendar ${appleScriptString(calendar)}
set matches to (every event whose uid is ${appleScriptString(id)})
if (count of matches) is not 1 then error "RICO_CALENDAR_NOT_FOUND" number 7302
set ev to item 1 of matches
set summary of ev to ${appleScriptString(title)}
set start date of ev to startDate
set end date of ev to endDate
set description of ev to ${appleScriptString(notes)}
set location of ev to ${appleScriptString(location)}
return "RICO_OK" & linefeed & (uid of ev as text)
end tell
end tell`;
  }
  return `${helpersScript()}
set startDate to my makeDate(${start.year}, ${start.month}, ${start.day}, ${start.hours}, ${start.minutes}, ${start.seconds})
set endDate to my makeDate(${end.year}, ${end.month}, ${end.day}, ${end.hours}, ${end.minutes}, ${end.seconds})
tell application "${CALENDAR_APP}"
tell calendar ${appleScriptString(calendar)}
set ev to make new event with properties ${createProps}
return "RICO_OK" & linefeed & (uid of ev as text)
end tell
end tell`;
}

function outlookHealthScript() {
  return `tell application id "${OUTLOOK_BUNDLE_ID}"
return "RICO_OK" & linefeed & (count of messages of inbox as text)
end tell`;
}

function outlookListScript(limit) {
  return `${helpersScript()}
tell application id "${OUTLOOK_BUNDLE_ID}"
set total to count of messages of inbox
set n to ${limit}
if total < n then set n to total
set rows to {}
repeat with i from 1 to n
set m to message i of inbox
set senderAddr to ""
try
set senderAddr to address of (sender of m) as text
end try
set end of rows to (id of m as text) & (character id 31) & my clipText(subject of m as text, ${MAX_SUBJECT_CHARS}) & (character id 31) & my clipText(senderAddr, 254) & (character id 31) & my isoDate(time received of m)
end repeat
set AppleScript's text item delimiters to character id 30
return "RICO_OK" & linefeed & (total as text) & linefeed & (n as text) & linefeed & (rows as text)
end tell`;
}

function outlookGetScript(id) {
  return `${helpersScript()}
tell application id "${OUTLOOK_BUNDLE_ID}"
set m to message id ${appleScriptNumber(id)}
set senderAddr to ""
try
set senderAddr to address of (sender of m) as text
end try
set bodyText to ""
try
set bodyText to plain text content of m as text
end try
set row to (id of m as text) & (character id 31) & my clipText(subject of m as text, ${MAX_SUBJECT_CHARS}) & (character id 31) & my clipText(senderAddr, 254) & (character id 31) & my isoDate(time received of m) & (character id 31) & my clipText(bodyText, ${MAX_MAIL_BODY_CHARS})
return "RICO_OK" & linefeed & "1" & linefeed & "1" & linefeed & row
end tell`;
}

function outlookDraftScript({ to, from, subject, text }) {
  return `tell application id "${OUTLOOK_BUNDLE_ID}"
set requestedSender to ${appleScriptString(from)}
set matchingAccounts to {}
repeat with candidate in ((every exchange account) & (every imap account) & (every pop account))
if (email address of candidate as text) is requestedSender then set end of matchingAccounts to candidate
end repeat
if (count of matchingAccounts) is not 1 then error "RICO_OUTLOOK_SOURCE_UNPROVEN" number 7201
set selectedAccount to item 1 of matchingAccounts
set newMessage to make new outgoing message with properties {subject:${appleScriptString(subject)}, plain text content:${appleScriptString(text)}, account:selectedAccount}
make new to recipient at newMessage with properties {email address:{address:${appleScriptString(to)}}}
if (was sent of newMessage) is true then error "RICO_OUTLOOK_DRAFT_SENT" number 7208
return "RICO_OK" & linefeed & (id of newMessage as text)
end tell`;
}

function appleScriptNumber(value) {
  const id = String(value ?? "").trim();
  if (!/^[0-9]{1,18}$/u.test(id)) throw fail("message_id_invalid", "Message id is invalid.");
  return id;
}

export const LOCAL_APP_BUNDLES = Object.freeze({
  mail: MAIL_BUNDLE_ID,
  calendar: CALENDAR_BUNDLE_ID,
  outlook: OUTLOOK_BUNDLE_ID,
});
