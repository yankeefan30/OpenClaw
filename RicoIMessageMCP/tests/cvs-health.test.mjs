import assert from "node:assert/strict";
import test from "node:test";
import {
  isCvsHealthCalendar,
  isCvsHealthMailAccount,
  pickCvsHealthCalendar,
  pickCvsHealthMailAccount,
  publicMailAccount,
} from "../cvs-health.mjs";

test("CVS Health mail matching uses account name or cvshealth.com addresses", () => {
  assert.equal(isCvsHealthMailAccount({ name: "CVS Health", emails: [] }), true);
  assert.equal(isCvsHealthMailAccount({
    name: "Exchange",
    emails: ["alan.rosa@cvshealth.com"],
  }), true);
  assert.equal(isCvsHealthMailAccount({
    name: "iCloud",
    emails: ["alan.a.rosa@icloud.com"],
  }), false);
  assert.equal(isCvsHealthMailAccount({
    name: "Gmail",
    emails: ["alan.a.rosa@gmail.com"],
  }), false);
});

test("CVS Health calendar matching prefers the account Calendar over a label-only calendar", () => {
  const calendars = [
    { name: "Home", account: "iCloud", writable: true },
    { name: "CVS Health", account: "CVS Health", writable: false },
    { name: "Calendar", account: "CVS Health", writable: true },
    { name: "Calendar", account: "iCloud", writable: true },
  ];
  assert.equal(isCvsHealthCalendar(calendars[2]), true);
  assert.equal(isCvsHealthCalendar(calendars[3]), false);
  const picked = pickCvsHealthCalendar(calendars);
  assert.equal(picked.name, "Calendar");
  assert.equal(picked.account, "CVS Health");
});

test("public mail accounts never include email addresses", () => {
  const published = publicMailAccount({
    name: "CVS Health",
    kind: "exchange",
    emails: ["alan.rosa@cvshealth.com"],
  });
  assert.equal(published.cvsHealth, true);
  assert.equal(published.name, "CVS Health");
  assert.ok(!Object.prototype.hasOwnProperty.call(published, "emails"));
  assert.ok(!JSON.stringify(published).includes("@"));
});

test("pickCvsHealthMailAccount prefers the reviewed mailbox when several match", () => {
  const picked = pickCvsHealthMailAccount([
    { name: "CVS Health Holidays", emails: ["holidays@cvshealth.com"] },
    { name: "CVS Health", emails: ["alan.rosa@cvshealth.com"] },
  ]);
  assert.equal(picked.name, "CVS Health");
});
