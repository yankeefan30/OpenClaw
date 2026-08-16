import assert from "node:assert/strict";
import test from "node:test";
import {
  isWithinEasternWindow,
  parseInboundRequest,
  validatePermissionGrant,
  WorkflowPolicyError,
} from "../policy.mjs";
import { grant, inbound } from "./fixtures.mjs";

const executionNow = new Date("2026-08-15T16:00:00Z");

test("grant contains exact identities, origins, and opaque references but no credentials", () => {
  assert.equal(grant.janetHandle, "+15550100200");
  assert.equal(grant.janetEmailRecipient, "janet.locked@example.test");
  assert.equal(grant.alanGmailSender, "alan.sendas@example.test");
  assert.equal(grant.openCaseOrigin, "https://opencase.example.test");
  assert.throws(() => validatePermissionGrant({
    ...grant,
    capabilityRefs: { ...grant.capabilityRefs, openCaseSession: "password=hunter2" },
  }), /Capability reference/);
});

test("only exact Janet direct inbound iMessage events with original thread identity match", () => {
  assert.equal(parseInboundRequest(inbound(), grant, executionNow).route, "opencase");
  for (const changed of [
    { senderHandle: "+15550100201" },
    { senderHandle: "Janet" },
    { channel: "sms" },
    { isGroup: true },
    { isFromMe: true },
    { chatGuid: "" },
    { messageTs: "" },
  ]) {
    assert.throws(() => parseInboundRequest(inbound(changed), grant, executionNow), WorkflowPolicyError);
  }
});

test("Rico and Polar are leading invocation aliases; vendor routing stays separate", () => {
  const openCase = parseInboundRequest(inbound({ content: "RICO: OpenCase receipt $12.00" }), grant, executionNow);
  const heygen = parseInboundRequest(inbound({ content: "@Polar Heygen receipt for $18.50" }), grant, executionNow);
  const fallback = parseInboundRequest(inbound({ content: "polar receipt from CVS for $9.99" }), grant, executionNow);
  assert.equal(openCase.route, "opencase");
  assert.equal(heygen.route, "heygen");
  assert.equal(heygen.alias, "polar");
  assert.equal(fallback.route, "general");
  assert.equal(fallback.vendorHint, "CVS");
  assert.deepEqual(fallback.locations, ["Genius Scan", "Alan Gmail", "CVS Outlook"]);
  assert.throws(() => parseInboundRequest(inbound({ content: "Please ask Polar for a receipt" }), grant, executionNow), /exact Rico or Polar alias/);
});

test("request parsing extracts bounded vendor, amount and date hints", () => {
  const request = parseInboundRequest(inbound(), grant, executionNow);
  assert.equal(request.vendorHint, "OpenCase");
  assert.equal(request.amountHint, "$42.17");
  assert.equal(request.dateHint, "2026-07-08");
  assert.equal(request.chatGuid, "iMessage;-;+15550100200");
  assert.equal(request.messageTs, "2026-08-15T11:59:59-04:00");
});

test("Eastern execution boundary is inclusive from 05:30 through 23:59 across DST", () => {
  assert.equal(isWithinEasternWindow("2026-08-15T09:29:00Z"), false);
  assert.equal(isWithinEasternWindow("2026-08-15T09:30:00Z"), true);
  assert.equal(isWithinEasternWindow("2026-08-16T03:59:59Z"), true);
  assert.equal(isWithinEasternWindow("2026-08-16T04:00:00Z"), false);
  assert.equal(isWithinEasternWindow("2026-01-15T10:30:00Z"), true);
  assert.throws(() => parseInboundRequest(inbound(), grant, new Date("2026-08-16T04:00:00Z")), /outside the 05:30-23:59/);
});

test("request identity binds original chat_guid, message_ts, sender and content", () => {
  const first = parseInboundRequest(inbound(), grant, executionNow);
  const second = parseInboundRequest(inbound({ messageTs: "2026-08-15T12:00:00-04:00" }), grant, executionNow);
  assert.notEqual(first.requestKey, second.requestKey);
});
