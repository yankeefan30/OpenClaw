import assert from "node:assert/strict";
import test from "node:test";
import {
  accountSelectFromName,
  calendarSelectFromName,
  eventToNotionPage,
  eventsToIcs,
  notionCvsCalendarTarget,
  planNotionSync,
} from "../notion-calendar-sync.mjs";
import { callTool } from "../tools.mjs";

test("CVS Health events map onto the Notion Calendar database properties", () => {
  const page = eventToNotionPage({
    id: "uid-1",
    calendar: "Calendar",
    account: "CVS Health",
    title: "1:1 Gary",
    start: "2026-08-21T17:00:00.000Z",
    end: "2026-08-21T17:30:00.000Z",
    location: "Teams",
  });
  assert.equal(page.properties.Name, "1:1 Gary");
  assert.equal(page.properties.UID, "uid-1");
  assert.equal(page.properties.Calendar, "Calendar");
  assert.equal(page.properties.Account, "CVS Health");
  assert.equal(page.properties.Location, "Teams");
  assert.equal(page.properties["date:When:start"], "2026-08-21T17:00:00.000Z");
  assert.equal(page.properties["date:When:end"], "2026-08-21T17:30:00.000Z");
  assert.equal(page.properties["date:When:is_datetime"], 1);
  assert.equal(calendarSelectFromName("Birthday"), "Other");
  assert.equal(accountSelectFromName("iCloud"), "Other");
  assert.equal(accountSelectFromName(""), "CVS Health");
});

test("ICS export stays local and does not invent attendees", () => {
  const ics = eventsToIcs([{
    id: "uid-1",
    title: "Finance, QBR",
    start: "2026-08-21T14:00:00.000Z",
    end: "2026-08-21T15:00:00.000Z",
    location: "HQ; 8th",
  }], { now: () => new Date("2026-08-21T18:00:00.000Z") });
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /SUMMARY:Finance\\, QBR/);
  assert.match(ics, /LOCATION:HQ\\; 8th/);
  assert.match(ics, /UID:uid-1/);
  assert.doesNotMatch(ics, /ATTENDEE/);
  assert.doesNotMatch(ics, /gmail\.com/i);
});

test("sync plan creates new UIDs and skips unchanged rows", () => {
  const events = [
    { id: "new", calendar: "Calendar", title: "New", start: "2026-08-22T10:00:00Z", end: "2026-08-22T10:30:00Z", location: "" },
    { id: "same", calendar: "Calendar", title: "Same", start: "2026-08-22T11:00:00Z", end: "2026-08-22T11:30:00Z", location: "" },
  ];
  const existingSame = eventToNotionPage(events[1], { account: "CVS Health" });
  const planned = planNotionSync({
    events,
    account: "CVS Health",
    existingByUid: new Map([["same", { page_id: "page-same", properties: existingSame.properties }]]),
  });
  assert.equal(planned.creates.length, 1);
  assert.equal(planned.creates[0].properties.UID, "new");
  assert.equal(planned.unchanged.length, 1);
  assert.equal(planned.updates.length, 0);
  assert.equal(planned.target.databaseId, notionCvsCalendarTarget().databaseId);
});

test("export tool returns Notion payloads without copying to personal calendars", async () => {
  const result = await callTool({
    localApps: {
      async calendarList(request) {
        assert.equal(request.calendar, "Calendar");
        assert.equal(request.account, "CVS Health");
        assert.equal(request.limit, 80);
        return {
          ok: true,
          client: "calendar",
          calendar: "Calendar",
          account: "CVS Health",
          windowDays: 7,
          truncated: false,
          events: [{
            id: "e1",
            calendar: "Calendar",
            title: "Langfish",
            start: "2026-08-21T16:29:00.000Z",
            end: "2026-08-21T17:00:00.000Z",
            location: "",
          }],
        };
      },
    },
  }, "rico_calendar_export_notion", { days: 7, calendar: "Calendar", account: "CVS Health" });
  assert.equal(result.ok, true);
  assert.equal(result.copyToPersonalCalendars, false);
  assert.equal(result.creates[0].properties.Name, "Langfish");
  assert.equal(result.target.url, notionCvsCalendarTarget().url);
  assert.match(result.ics, /SUMMARY:Langfish/);
});
