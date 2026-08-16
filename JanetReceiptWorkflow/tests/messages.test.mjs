import assert from "node:assert/strict";
import test from "node:test";
import {
  acknowledgementText,
  loginBlockedCloseText,
  notFoundCloseText,
  sentCloseText,
} from "../messages.mjs";

test("acknowledgement wording is exact, short, and never names the agent Polar", () => {
  assert.equal(acknowledgementText("OpenCase"), "I’m pulling the OpenCase receipt now.");
  assert.equal(acknowledgementText(null), "I’m pulling it now.");
  assert.doesNotMatch(acknowledgementText(null), /Polar|emoji|🤖/u);
});

test("sent close uses Month Year, then amount, then a safe fallback", () => {
  assert.equal(
    sentCloseText({ vendor: "Heygen", date: "2026-07-08", amount: "$42.17" }),
    "Heygen receipt for July 2026 is on the way.",
  );
  assert.equal(
    sentCloseText({ vendor: "CVS", date: null, amount: "$9.99" }),
    "CVS receipt for $9.99 is on the way.",
  );
  assert.equal(sentCloseText({}), "Your receipt is on the way.");
});

test("not-found and login-blocked close wording names exact checked locations", () => {
  assert.equal(
    notFoundCloseText({ vendor: "CVS", locations: ["Genius Scan", "Alan Gmail", "CVS Outlook"] }),
    "I couldn’t find the CVS receipt. I checked Genius Scan, Alan Gmail, and CVS Outlook.",
  );
  assert.equal(
    loginBlockedCloseText("OpenCase"),
    "I hit a login block while retrieving the OpenCase receipt. Alan needs to complete the login.",
  );
});
