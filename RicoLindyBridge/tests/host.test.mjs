import assert from "node:assert/strict";
import test from "node:test";
import { assertOriginalRicoHost, isOriginalRicoHost } from "../host.mjs";

test("only original Rico.local is the apply host", () => {
  assert.equal(isOriginalRicoHost("Rico.local"), true);
  assert.equal(isOriginalRicoHost("rico"), true);
  assert.equal(isOriginalRicoHost("Rico"), true);
  assert.equal(isOriginalRicoHost("rico2"), false);
  assert.equal(isOriginalRicoHost("Rico-2.local"), false);
  assert.equal(isOriginalRicoHost("goon-mac"), false);
});

test("listen refuses Rico 2 unless Polar override is explicit", () => {
  assert.throws(() => assertOriginalRicoHost({ hostname: "Rico-2.local", allowNonRico: false }), {
    code: "host_refused",
  });
  assert.deepEqual(assertOriginalRicoHost({ hostname: "Rico.local", allowNonRico: false }), {
    ok: true,
    hostname: "rico.local",
    enforced: true,
  });
  assert.equal(assertOriginalRicoHost({ hostname: "ci-runner", allowNonRico: true }).enforced, false);
});
