import assert from "node:assert/strict";
import test from "node:test";
import { callTool } from "../tools.mjs";

function cvsRuntime() {
  return {
    localApps: {
      async mailHealth() { return { name: "mail", installed: true, reachable: true, inboxCount: 12 }; },
      async calendarHealth() { return { name: "calendar", installed: true, reachable: true, calendarCount: 4 }; },
      async outlookHealth() { return { name: "outlook", installed: false, reachable: false, error: "outlook_not_installed" }; },
      async mailListAccounts() {
        return {
          ok: true,
          accounts: [
            { name: "iCloud", kind: "iCloud", emails: ["alan.a.rosa@icloud.com"] },
            { name: "CVS Health", kind: "exchange", emails: ["alan.rosa@cvshealth.com"] },
          ],
        };
      },
      async calendarListCalendars() {
        return {
          ok: true,
          calendars: [
            { name: "Home", account: "iCloud", writable: true },
            { name: "Calendar", account: "CVS Health", writable: true },
            { name: "CVS Health", account: "CVS Health", writable: false },
          ],
        };
      },
      async mailListInbox(request) {
        return { ok: true, client: "mail", account: request.account, mailbox: request.mailbox, total: 1, truncated: false, messages: [{ id: "1", subject: "Work", from: "boss@cvshealth.com", date: "2026-08-21" }] };
      },
      async mailGet(request) {
        return { ok: true, client: "mail", account: request.account, message: { id: request.id, subject: "Work", from: "boss@cvshealth.com", date: "2026-08-21", body: "Body" } };
      },
      async calendarList(request) {
        return { ok: true, client: "calendar", calendar: request.calendar, account: request.account, windowDays: request.days, truncated: false, events: [{ id: "e1", calendar: request.calendar, title: "1:1", start: "2026-08-22T15:00:00Z", end: "2026-08-22T15:30:00Z", location: "" }] };
      },
      async calendarUpsert(request) {
        return { ok: true, client: "calendar", id: "e-new", calendar: request.calendar, account: request.account, title: request.title, created: true };
      },
      async mailSend() { throw new Error("should-not-send-mail"); },
    },
  };
}

test("Notion profile health binds CVS Health mail and iCal without leaking personal accounts", async () => {
  const result = await callTool(cvsRuntime(), "rico_local_apps_health", {}, { profile: "notion-cvs" });
  assert.equal(result.profile, "notion-cvs");
  assert.equal(result.ok, true);
  assert.equal(result.mail.cvsHealth, true);
  assert.equal(result.mail.account, "CVS Health");
  assert.equal(result.calendar.cvsHealth, true);
  assert.equal(result.calendar.calendar, "Calendar");
  assert.equal(result.calendar.account, "CVS Health");
  assert.ok(!JSON.stringify(result).includes("icloud.com"));
  assert.ok(!JSON.stringify(result).includes("gmail.com"));
});

test("Notion profile auto-scopes mail and calendar to CVS Health", async () => {
  const listed = await callTool(cvsRuntime(), "rico_mail_list_inbox", { limit: 5 }, { profile: "notion-cvs" });
  assert.equal(listed.account, "CVS Health");
  assert.equal(listed.mailbox, "INBOX");

  const events = await callTool(cvsRuntime(), "rico_calendar_list", { days: 7 }, { profile: "notion-cvs" });
  assert.equal(events.calendar, "Calendar");
  assert.equal(events.account, "CVS Health");
  assert.equal(events.events[0].title, "1:1");
});

test("Notion profile refuses personal mailboxes and calendars", async () => {
  await assert.rejects(
    callTool(cvsRuntime(), "rico_mail_list_inbox", { account: "iCloud" }, { profile: "notion-cvs" }),
    { code: "cvs_health_mail_not_found" },
  );
  await assert.rejects(
    callTool(cvsRuntime(), "rico_calendar_list", { calendar: "Home", account: "iCloud" }, { profile: "notion-cvs" }),
    { code: "cvs_health_calendar_not_found" },
  );
});

test("Notion profile account inventory hides non-CVS Health mailboxes", async () => {
  const listed = await callTool(cvsRuntime(), "rico_mail_list_accounts", {}, { profile: "notion-cvs" });
  assert.deepEqual(listed.accounts.map((account) => account.name), ["CVS Health"]);
  const calendars = await callTool(cvsRuntime(), "rico_calendar_list_calendars", {}, { profile: "notion-cvs" });
  assert.deepEqual(calendars.calendars.map((calendar) => calendar.name), ["Calendar", "CVS Health"]);
  assert.ok(calendars.calendars.every((calendar) => calendar.cvsHealth));
});

test("Notion profile does not expose Mail send", async () => {
  await assert.rejects(
    callTool(cvsRuntime(), "rico_mail_send", { to: "janet@example.com", subject: "Hi", text: "Hi" }, { profile: "notion-cvs" }),
    { code: "tool_not_found" },
  );
});
