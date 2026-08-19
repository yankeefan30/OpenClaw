import assert from "node:assert/strict";
import test from "node:test";
import { assertOriginalRicoHost, isOriginalRicoHost, normalizeHostLabel } from "../hostname.mjs";

test("original Rico hostnames are accepted", () => {
  assert.equal(isOriginalRicoHost({ hostname: "Rico.local", localHostName: "Rico" }), true);
  assert.equal(isOriginalRicoHost({ hostname: "rico.local", localHostName: "" }), true);
  assert.equal(isOriginalRicoHost({ hostname: "Rico", localHostName: "" }), true);
  assert.equal(isOriginalRicoHost({ hostname: "cursor", localHostName: "Rico" }), true);
});

test("Rico 2 and other machines are refused", () => {
  assert.equal(isOriginalRicoHost({ hostname: "Rico-2.local", localHostName: "Rico-2" }), false);
  assert.equal(isOriginalRicoHost({ hostname: "Rico2.local", localHostName: "Rico2" }), false);
  assert.equal(isOriginalRicoHost({ hostname: "rico-2.local", localHostName: "Rico 2" }), false);
  assert.equal(isOriginalRicoHost({ hostname: "localhost", localHostName: "" }), false);
  assert.equal(isOriginalRicoHost({ hostname: "cursor", localHostName: "" }), false);
  assert.equal(isOriginalRicoHost({ hostname: "Rico.local.evil", localHostName: "" }), false);
});

test("assertOriginalRicoHost fails closed with a precise error", async () => {
  await assert.rejects(
    () => assertOriginalRicoHost(async () => ({ hostname: "Rico-2.local", localHostName: "Rico-2" })),
    (error) => {
      assert.equal(error.code, "host_refused");
      assert.match(error.message, /original Rico/);
      assert.match(error.message, /Rico 2/);
      return true;
    },
  );
  const ok = await assertOriginalRicoHost(async () => ({ hostname: "Rico.local", localHostName: "Rico" }));
  assert.equal(ok.hostname, "Rico.local");
});

test("host labels normalize without leaking extra suffixes", () => {
  assert.equal(normalizeHostLabel("Rico.local."), "rico.local");
  assert.equal(normalizeHostLabel("  Rico  "), "rico");
});
