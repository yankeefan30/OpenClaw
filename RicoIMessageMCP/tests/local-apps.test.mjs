import assert from "node:assert/strict";
import test from "node:test";
import { callTool } from "../tools.mjs";
import { createLocalApps } from "../local-apps.mjs";

function record(fields) {
  return fields.join("\u001f");
}

test("Mail list and get stay bounded and use the injected runner", async () => {
  const scripts = [];
  const apps = createLocalApps({
    outlookAppPath: "/tmp/rico-outlook-missing",
    runner: async (script) => {
      scripts.push(script);
      if (script.includes("set theBox to inbox") && script.includes("repeat with i")) {
        return `RICO_OK\n2\n2\n${record(["11", "Hello", "janet@example.com", "2026-08-16T12:00:00"])}\u001e${record(["10", "Earlier", "owner@example.com", "2026-08-16T11:00:00"])}`;
      }
      if (script.includes("whose id is 11")) {
        return `RICO_OK\n1\n1\n${record(["11", "Hello", "janet@example.com", "2026-08-16T12:00:00", "Bounded body"])}`;
      }
      throw new Error(`unexpected script: ${script.slice(0, 80)}`);
    },
  });

  const listed = await callTool({ localApps: apps }, "rico_mail_list_inbox", { limit: 2 });
  assert.equal(listed.ok, true);
  assert.equal(listed.total, 2);
  assert.equal(listed.truncated, true);
  assert.equal(listed.messages.length, 2);
  assert.equal(listed.messages[0].id, "11");
  assert.ok(!JSON.stringify(listed).includes("Bounded body"));

  const one = await callTool({ localApps: apps }, "rico_mail_get", { id: "11" });
  assert.equal(one.message.body, "Bounded body");
  assert.equal(scripts.length, 2);
});

test("Calendar upsert and list go through the mocked AppleScript runner", async () => {
  const apps = createLocalApps({
    outlookAppPath: "/tmp/rico-outlook-missing",
    now: () => new Date("2026-08-16T15:00:00-04:00"),
    runner: async (script) => {
      if (script.includes("every event of cal whose start date")) {
        return `RICO_OK\n3\n1\n${record(["uid-1", "Home", "Dentist", "2026-08-17T10:00:00", "2026-08-17T11:00:00", "Office"])}`;
      }
      if (script.includes("make new event with properties")) {
        return "RICO_OK\nuid-created";
      }
      throw new Error("unexpected calendar script");
    },
  });

  const listed = await callTool({ localApps: apps }, "rico_calendar_list", { days: 7, calendar: "Home" });
  assert.equal(listed.events[0].title, "Dentist");
  assert.equal(listed.events[0].calendar, "Home");

  const created = await callTool({ localApps: apps }, "rico_calendar_upsert", {
    calendar: "Home",
    title: "Follow-up",
    start: "2026-08-18T10:00:00",
    end: "2026-08-18T10:30:00",
    notes: "Local only",
  });
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.equal(created.id, "uid-created");
});

test("Outlook health can be reachable for read while governed send is not configured", async () => {
  const result = await callTool({
    localApps: {
      async mailHealth() { return { name: "mail", installed: true, reachable: true, inboxCount: 1 }; },
      async calendarHealth() { return { name: "calendar", installed: true, reachable: true, calendarCount: 1 }; },
      async outlookHealth() {
        return { name: "outlook", installed: true, reachable: true, configured: false, inboxCount: 0, error: "outlook_not_configured" };
      },
    },
  }, "rico_local_apps_health", {});
  assert.equal(result.outlook.installed, true);
  assert.equal(result.outlook.reachable, true);
  assert.equal(result.outlook.configured, false);
  assert.equal(result.outlook.error, "outlook_not_configured");
  assert.equal(result.ok, true);
});

test("Outlook tools return a clear error when Outlook is not installed", async () => {
  const apps = createLocalApps({
    outlookAppPath: "/tmp/rico-outlook-missing",
    runner: async () => {
      throw new Error("should-not-applescript-outlook");
    },
    outlookAdapter: {
      async health() { return { ok: false, errorCode: "native_outlook_app_invalid" }; },
      async sendEmail() { throw new Error("should-not-send"); },
    },
  });

  const health = await callTool({ localApps: apps }, "rico_local_apps_health", {});
  assert.equal(health.outlook.installed, false);
  assert.equal(health.outlook.reachable, false);
  assert.equal(health.outlook.error, "outlook_not_installed");
  assert.ok(!JSON.stringify(health).includes("should-not-send"));
  assert.ok(!JSON.stringify(health).includes("token"));

  await assert.rejects(
    callTool({ localApps: apps }, "rico_outlook_list_inbox", {}),
    { code: "outlook_not_installed" },
  );
  await assert.rejects(
    callTool({ localApps: apps }, "rico_outlook_get", { id: "1" }),
    { code: "outlook_not_installed" },
  );
});

test("local app health never echoes secrets or account identifiers", async () => {
  const secret = "super-secret-outlook-token";
  const apps = {
    async mailHealth() { return { name: "mail", installed: true, reachable: true, inboxCount: 3, token: secret }; },
    async calendarHealth() { return { name: "calendar", installed: true, reachable: true, calendarCount: 2 }; },
    async outlookHealth() {
      return { name: "outlook", installed: true, reachable: true, configured: true, accountId: "should-not-leak", token: secret };
    },
  };
  const result = await callTool({ localApps: apps }, "rico_local_apps_health", {});
  assert.equal(result.mail.reachable, true);
  assert.equal(result.calendar.calendarCount, 2);
  assert.equal(result.outlook.configured, true);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!JSON.stringify(result).includes("should-not-leak"));
  assert.ok(!Object.prototype.hasOwnProperty.call(result.outlook, "accountId"));
});

test("automation denial is a clear error and does not look like a crash", async () => {
  const apps = createLocalApps({
    outlookAppPath: "/tmp/rico-outlook-missing",
    runner: async () => {
      const error = new Error("denied");
      error.code = "automation_denied";
      throw error;
    },
  });
  await assert.rejects(
    callTool({ localApps: apps }, "rico_mail_list_inbox", {}),
    { code: "automation_denied" },
  );
});

test("Mail account inventory strips extra emails from the public tool result", async () => {
  const apps = createLocalApps({
    outlookAppPath: "/tmp/rico-outlook-missing",
    runner: async (script) => {
      if (script.includes("email addresses of acc")) {
        return `RICO_OK\n2\n2\n${record(["iCloud", "iCloud", "alan.a.rosa@icloud.com"])}\u001e${record(["CVS Health", "exchange", "alan.rosa@cvshealth.com,al.rosa@cvshealth.com"])}`;
      }
      throw new Error(`unexpected script: ${script.slice(0, 80)}`);
    },
  });
  const listed = await callTool({ localApps: apps }, "rico_mail_list_accounts", {});
  assert.equal(listed.accounts.length, 2);
  assert.equal(listed.accounts[1].name, "CVS Health");
  assert.equal(listed.accounts[1].cvsHealth, true);
  assert.equal(listed.accounts[0].cvsHealth, false);
  assert.ok(!JSON.stringify(listed).includes("alan.rosa@cvshealth.com"));
  assert.ok(!JSON.stringify(listed).includes("icloud.com"));
});

test("Mail list can target one Mail.app account inbox", async () => {
  const apps = createLocalApps({
    outlookAppPath: "/tmp/rico-outlook-missing",
    runner: async (script) => {
      assert.ok(script.includes('"CVS Health"'));
      assert.ok(script.includes("requireAccount"));
      assert.ok(script.includes("accountInbox"));
      return `RICO_OK\n1\n1\n${record(["99", "Work note", "boss@cvshealth.com", "2026-08-21T12:00:00"])}`;
    },
  });
  const listed = await callTool({ localApps: apps }, "rico_mail_list_inbox", { account: "CVS Health", limit: 5 });
  assert.equal(listed.account, "CVS Health");
  assert.equal(listed.mailbox, "INBOX");
  assert.equal(listed.messages[0].id, "99");
});

test("Calendar inventory falls back to AppleScript when EventKit is denied", async () => {
  const apps = createLocalApps({
    outlookAppPath: "/tmp/rico-outlook-missing",
    runner: async (script) => {
      if (script.includes("EKEventStore")) {
        const error = new Error("denied");
        error.code = "automation_denied";
        throw error;
      }
      if (script.includes("repeat with cal in calendars") && script.includes("writableFlag")) {
        return `RICO_OK\n2\n2\n${record(["Calendar", "", "true"])}\u001e${record(["Home", "", "true"])}`;
      }
      throw new Error("unexpected calendar inventory script");
    },
  });
  const listed = await callTool({ localApps: apps }, "rico_calendar_list_calendars", {});
  assert.equal(listed.calendars.length, 2);
  assert.equal(listed.calendars[0].name, "Calendar");
  assert.equal(listed.calendars[0].writable, true);
});

