import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runJanetReceiptWorkflow } from "../handler.mjs";
import { ReceiptLedger } from "../ledger.mjs";
import { grant, inbound } from "./fixtures.mjs";

const executionNow = new Date("2026-08-15T16:00:00Z");

function pdfCandidate({
  location = "OpenCase portal",
  vendor = "OpenCase",
  amount = "$42.17",
  date = "2026-07-08",
  sourceUrl = "https://opencase.example.test/receipts/receipt-1",
} = {}) {
  return {
    sourceLocation: location,
    sourceUrl,
    sourceRecordId: `${location.toLowerCase().replace(/\s+/gu, "-")}-receipt-1`,
    mimeType: "application/pdf",
    fileName: "receipt.pdf",
    bytes: Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "ascii"),
    metadata: { vendor, amount, date },
  };
}

function response(candidate, sessionId = "session-1") {
  return { status: "ok", matches: [candidate], sessionId };
}

function makeHarness({ searches = {}, signature, send } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "janet-handler-test-"));
  const ledger = new ReceiptLedger(path.join(root, "ledger.json"));
  const order = [];
  const replies = [];
  const calls = { searches: {}, emails: [], signatures: [], closes: [], reports: [] };
  const defaults = {
    openCase: { status: "not_found", matches: [], sessionId: "open-case-session" },
    heygen: { status: "not_found", matches: [], sessionId: "heygen-session" },
    geniusScan: { status: "not_found", matches: [] },
    alanGmail: { status: "not_found", matches: [] },
    cvsOutlook: { status: "not_found", matches: [] },
  };
  const search = (key, label) => async (input) => {
    order.push(`search:${label}`);
    calls.searches[key] ??= [];
    calls.searches[key].push(input);
    const configured = searches[key] ?? defaults[key];
    return typeof configured === "function" ? configured(input) : configured;
  };
  const services = {
    imessage: {
      async replyInThread(input) {
        order.push(`reply:${input.phase}`);
        replies.push(input);
        return { ok: true };
      },
    },
    receipts: {
      openCase: { search: search("openCase", "OpenCase portal") },
      heygen: { search: search("heygen", "Heygen portal") },
      geniusScan: { search: search("geniusScan", "Genius Scan") },
      alanGmail: { search: search("alanGmail", "Alan Gmail") },
      cvsOutlook: { search: search("cvsOutlook", "CVS Outlook") },
      async closeSessions(input) {
        order.push("sessions:close");
        calls.closes.push(input);
        return { ok: true };
      },
    },
    gmail: {
      async getSendAsSignature(input) {
        order.push("signature");
        calls.signatures.push(input);
        if (typeof signature === "function") return signature(input);
        return signature ?? {
          ok: true,
          from: grant.alanGmailSender,
          content: "Alan's configured signature",
          format: "plain",
        };
      },
      async sendReceipt(input) {
        order.push("email");
        calls.emails.push(input);
        if (typeof send === "function") return send(input);
        return send ?? {
          ok: true,
          from: grant.alanGmailSender,
          to: grant.janetEmailRecipient,
          messageId: "provider-message-1",
        };
      },
    },
  };
  const reporter = {
    async record(report) {
      order.push("report");
      calls.reports.push(report);
      return { ok: true };
    },
  };
  return { ledger, order, replies, calls, services, reporter };
}

async function run(harness, event = inbound()) {
  return runJanetReceiptWorkflow({
    event: { runId: "test-run-1", ...event },
    permissionGrant: grant,
    ledger: harness.ledger,
    services: harness.services,
    reporter: harness.reporter,
    now: executionNow,
  });
}

test("OpenCase success uses only its portal, same-thread deterministic replies, and exact Gmail locks", async () => {
  const candidate = pdfCandidate();
  const harness = makeHarness({ searches: { openCase: response(candidate, "open-case-session") } });
  const result = await run(harness);

  assert.equal(result.outcome, "sent");
  assert.deepEqual(harness.order, [
    "reply:ack",
    "search:OpenCase portal",
    "signature",
    "email",
    "sessions:close",
    "reply:close",
    "report",
  ]);
  assert.deepEqual(harness.replies.map(({ text }) => text), [
    "I’m pulling the OpenCase receipt now.",
    "OpenCase receipt for July 2026 is on the way.",
  ]);
  for (const reply of harness.replies) {
    assert.equal(reply.chatGuid, "iMessage;-;+15550100200");
    assert.equal(reply.messageTs, "2026-08-15T11:59:59-04:00");
    assert.equal(reply.to, grant.janetHandle);
  }
  assert.deepEqual(Object.keys(harness.calls.searches), ["openCase"]);
  assert.equal(harness.calls.searches.openCase[0].capabilityRef, grant.capabilityRefs.openCaseSession);
  assert.equal(harness.calls.searches.openCase[0].exactOrigin, grant.openCaseOrigin);

  const email = harness.calls.emails[0];
  assert.equal(email.accountRef, grant.capabilityRefs.alanGmail);
  assert.equal(email.from, grant.alanGmailSender);
  assert.equal(email.to, grant.janetEmailRecipient);
  assert.deepEqual(email.cc, []);
  assert.deepEqual(email.bcc, []);
  assert.deepEqual(email.signature, { content: "Alan's configured signature", format: "plain" });
  assert.equal(email.attachment.mimeType, "application/pdf");
  assert.match(email.idempotencyKey, /^[a-f0-9]{64}:email$/u);

  assert.deepEqual({
    chat_guid: harness.calls.reports[0].chat_guid,
    message_ts: harness.calls.reports[0].message_ts,
    vendor: harness.calls.reports[0].vendor,
    amount: harness.calls.reports[0].amount,
    date: harness.calls.reports[0].date,
    outcome: harness.calls.reports[0].outcome,
    run_at: harness.calls.reports[0].run_at,
  }, {
    chat_guid: "iMessage;-;+15550100200",
    message_ts: "2026-08-15T11:59:59-04:00",
    vendor: "OpenCase",
    amount: "$42.17",
    date: "2026-07-08",
    outcome: "sent",
    run_at: "2026-08-15T16:00:00.000Z",
  });

  assert.deepEqual(harness.ledger.records(), [{
    chat_guid: "iMessage;-;+15550100200",
    message_ts: "2026-08-15T11:59:59-04:00",
    vendor: "OpenCase",
    outcome: "sent",
    run_at: "2026-08-15T16:00:00.000Z",
    request_hash: result.requestKey,
  }]);
});

test("Polar is only an invocation alias; Heygen routing never searches a Polar location", async () => {
  const candidate = pdfCandidate({
    location: "Heygen portal",
    vendor: "Heygen",
    amount: "$18.50",
    date: null,
    sourceUrl: "https://heygen.example.test/billing/receipt-1",
  });
  const harness = makeHarness({ searches: { heygen: response(candidate, "heygen-session") } });
  const result = await run(harness, inbound({ content: "@polar Heygen receipt for $18.50" }));

  assert.equal(result.outcome, "sent");
  assert.deepEqual(Object.keys(harness.calls.searches), ["heygen"]);
  assert.deepEqual(harness.replies.map(({ text }) => text), [
    "I’m pulling the Heygen receipt now.",
    "Heygen receipt for $18.50 is on the way.",
  ]);
  assert.doesNotMatch(JSON.stringify({ replies: harness.replies, reports: harness.calls.reports }), /Polar (?:portal|receipt|agent)/iu);
});

test("general route checks Genius Scan, Alan Gmail, then CVS Outlook and stops on first exact match", async () => {
  const candidate = pdfCandidate({
    location: "CVS Outlook",
    vendor: "CVS",
    amount: "$9.99",
    date: "2026-08-01",
    sourceUrl: undefined,
  });
  const harness = makeHarness({ searches: { cvsOutlook: response(candidate, "outlook-session") } });
  const result = await run(harness, inbound({ content: "Rico receipt from CVS for $9.99" }));

  assert.equal(result.outcome, "sent");
  assert.deepEqual(harness.order.slice(0, 6), [
    "reply:ack",
    "search:Genius Scan",
    "search:Alan Gmail",
    "search:CVS Outlook",
    "signature",
    "email",
  ]);
  assert.deepEqual(result.checkedLocations, ["Genius Scan", "Alan Gmail", "CVS Outlook"]);
  assert.equal(harness.replies[1].text, "CVS receipt for August 2026 is on the way.");
});

test("not-found closes in the source thread with every exact checked location and sends no email", async () => {
  const harness = makeHarness();
  const result = await run(harness, inbound({ content: "@rico receipt from CVS for $9.99" }));

  assert.equal(result.outcome, "not_found");
  assert.equal(harness.calls.emails.length, 0);
  assert.equal(harness.calls.signatures.length, 0);
  assert.equal(harness.replies[1].text, "I couldn’t find the CVS receipt. I checked Genius Scan, Alan Gmail, and CVS Outlook.");
  assert.deepEqual(harness.order, [
    "reply:ack",
    "search:Genius Scan",
    "search:Alan Gmail",
    "search:CVS Outlook",
    "sessions:close",
    "reply:close",
    "report",
  ]);
});

for (const status of ["login_required", "two_factor_required", "captcha_required"]) {
  test(`${status} fails closed with the exact login handoff and no email`, async () => {
    const harness = makeHarness({ searches: { openCase: { status, matches: [], sessionId: "blocked-session" } } });
    const result = await run(harness);

    assert.equal(result.outcome, "blocked_login");
    assert.equal(harness.calls.emails.length, 0);
    assert.equal(harness.replies[1].text, "I hit a login block while retrieving the OpenCase receipt. Alan needs to complete the login.");
    assert.deepEqual(harness.calls.closes[0].sessionIds, ["blocked-session"]);
  });
}

test("ambiguous search and invalid PDF evidence fail closed before signature or email", async () => {
  const ambiguous = makeHarness({ searches: { openCase: { status: "ok", matches: [pdfCandidate(), pdfCandidate()], sessionId: "ambiguous-session" } } });
  const ambiguousResult = await run(ambiguous);
  assert.equal(ambiguousResult.outcome, "blocked_ambiguous");
  assert.equal(ambiguous.calls.emails.length, 0);
  assert.equal(ambiguous.calls.signatures.length, 0);

  const invalidCandidate = { ...pdfCandidate(), sourceLocation: "Alan Gmail" };
  const invalid = makeHarness({ searches: { openCase: response(invalidCandidate) } });
  const invalidResult = await run(invalid);
  assert.equal(invalidResult.outcome, "blocked_evidence");
  assert.equal(invalid.calls.emails.length, 0);
  assert.equal(invalid.calls.signatures.length, 0);
});

test("ambiguous or impossible extracted dates fail closed instead of being guessed", async () => {
  for (const date of ["02/03/2026", "2026-02-30"]) {
    const harness = makeHarness({ searches: { openCase: response(pdfCandidate({ date })) } });
    const result = await run(harness);
    assert.equal(result.outcome, "blocked_evidence");
    assert.equal(result.reason, "date_invalid");
    assert.equal(harness.calls.emails.length, 0);
  }
});

test("candidate vendor, amount, and date must match every supplied request hint", async () => {
  for (const [candidateChanges, reason] of [
    [{ vendor: "Different Vendor" }, "vendor_mismatch"],
    [{ amount: "$99.99" }, "amount_mismatch"],
    [{ date: "2026-07-09" }, "date_mismatch"],
  ]) {
    const harness = makeHarness({ searches: { openCase: response(pdfCandidate(candidateChanges)) } });
    const result = await run(harness);
    assert.equal(result.outcome, "blocked_evidence");
    assert.equal(result.reason, reason);
    assert.equal(harness.calls.signatures.length, 0);
    assert.equal(harness.calls.emails.length, 0);
  }
});

test("missing exact Gmail send-as signature blocks without reserving or sending email", async () => {
  const harness = makeHarness({
    searches: { openCase: response(pdfCandidate()) },
    signature: { ok: true, from: "different@example.test", content: "Wrong identity", format: "plain" },
  });
  const result = await run(harness);

  assert.equal(result.outcome, "blocked_signature");
  assert.equal(harness.calls.emails.length, 0);
  assert.equal(harness.ledger.entries().filter(({ transition }) => transition === "email_reserved").length, 0);
});

test("unknown Gmail result is not retried, including after replay of the same source message", async () => {
  const harness = makeHarness({
    searches: { openCase: response(pdfCandidate()) },
    send: { ok: true, from: grant.alanGmailSender, to: "unexpected@example.test", messageId: "uncertain" },
  });
  const first = await run(harness);
  const second = await run(harness);

  assert.equal(first.outcome, "email_outcome_unknown");
  assert.equal(second.status, "duplicate");
  assert.equal(harness.calls.emails.length, 1);
  assert.equal(harness.ledger.entries().filter(({ transition }) => transition === "email_reserved").length, 1);
});

test("non-Janet, group, and outside-window events are ignored before dependencies or side effects", async () => {
  for (const [event, now, reason] of [
    [inbound({ senderHandle: "+15550100201" }), executionNow, "sender_mismatch"],
    [inbound({ isGroup: true }), executionNow, "group_denied"],
    [inbound(), new Date("2026-08-16T04:00:00Z"), "outside_window"],
  ]) {
    const result = await runJanetReceiptWorkflow({ event, permissionGrant: grant, ledger: null, services: null, reporter: null, now });
    assert.deepEqual(result, { handled: false, status: "ignored", reason });
  }
});
