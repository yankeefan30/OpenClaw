import assert from "node:assert/strict";
import test from "node:test";
import { compileNaturalLanguage, resolveRecipient, validatePlan } from "./compiler.js";

const identities = [
  { kind: "individual", access: "owner", displayName: "Alan Rosa", target: "+16469433060", autoReply: true },
  { kind: "individual", access: "approved", displayName: "Janet Cummings", target: "+15550000002", autoReply: true },
];

test("compiles owner one-shot and weekday texts", () => {
  const now = new Date("2026-08-16T12:55:00-04:00");
  const once = compileNaturalLanguage({
    text: "text me standup in 10 at 8:50am",
    now,
    ownerHandle: "+16469433060",
    identities,
  });
  assert.equal(once.ok, true);
  assert.equal(once.plan.recipient, "+16469433060");
  assert.equal(once.plan.payload.text, "standup in 10");
  assert.equal(once.plan.schedule.type, "at");

  const recurring = compileNaturalLanguage({
    text: "every weekday at 8am text me review the ISTS board",
    now,
    ownerHandle: "+16469433060",
    identities,
  });
  assert.equal(recurring.ok, true);
  assert.equal(recurring.plan.schedule.type, "cron");
  assert.equal(recurring.plan.schedule.expr, "0 8 * * 1-5");
});

test("resolves reviewed names and rejects strangers", () => {
  const janet = resolveRecipient({ token: "Janet Cummings", ownerHandle: "+16469433060", identities });
  assert.equal(janet.ok, true);
  assert.equal(janet.handle, "+15550000002");
  const stranger = resolveRecipient({ token: "+15559999999", ownerHandle: "+16469433060", identities });
  assert.equal(stranger.ok, false);
});

test("validatePlan accepts exact text to owner", () => {
  const result = validatePlan({
    schemaVersion: 1,
    kind: "schedule_text",
    recipient: "me",
    schedule: { type: "at", at: "2026-08-16T15:00:00-04:00" },
    payload: { type: "exact_text", text: "Leave for dinner." },
  }, { ownerHandle: "+16469433060", identities });
  assert.equal(result.ok, true);
  assert.equal(result.plan.recipient, "+16469433060");
});
