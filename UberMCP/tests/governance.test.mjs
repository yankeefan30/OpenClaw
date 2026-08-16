import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseCredentialBundle } from "../credentials.mjs";
import { DisabledGeocoderAdapter } from "../geocoder.mjs";
import { verifyInvocationProof } from "../invocation-proof.mjs";
import { InvocationProofIssuerV5 } from "../proof-issuer.mjs";
import { HashChainedLedger } from "../private-store.mjs";
import { PersistentRateLimiter } from "../rate-limiter.mjs";
import { TOOL_DEFINITIONS } from "../tools.mjs";
import { validateChallengeInput } from "../validation.mjs";
import { KEY, NOW, proofFor, validBundle } from "./helpers.mjs";

test("reviewed credential bundle requires official origins, separate keys, aliases, and privileged scopes", () => {
  const bundle = parseCredentialBundle(Buffer.from(JSON.stringify(validBundle())), NOW);
  assert.equal(bundle.environment, "sandbox");
  assert.notEqual(bundle.invocationHmacKey, bundle.locationHmacKey);
  const missing = validBundle(); missing.scopes = ["profile", "offline_access"];
  assert.throws(() => parseCredentialBundle(Buffer.from(JSON.stringify(missing)), NOW), { code: "privileged_request_scope_missing" });
  const badOrigin = validBundle(); badOrigin.apiBaseUrl = "https://example.com";
  assert.throws(() => parseCredentialBundle(Buffer.from(JSON.stringify(badOrigin)), NOW), { code: "api_origin_invalid" });
  const reusedKey = validBundle(); reusedKey.locationHmacKey = reusedKey.invocationHmacKey;
  assert.throws(() => parseCredentialBundle(Buffer.from(JSON.stringify(reusedKey)), NOW), { code: "location_key_invalid" });
});

test("v5 production issuer overwrites untrusted proof and binds full args/tool call/message/run", async () => {
  const provider = { withSecret: async (operation) => operation(Buffer.from(JSON.stringify(validBundle()))) };
  const issuer = new InvocationProofIssuerV5({ credentialProvider: provider, now: () => NOW });
  const evidence = {
    guardContract: "rico-recipient-guard/v5",
    authenticatedOwner: true,
    principalHandle: "+10000000000",
    messageId: "message-1",
    messageBody: "@rico find an Uber",
    conversationId: "owner-chat",
    runId: "run-1",
    channel: "imessage",
    toolName: "uber_location_search",
    toolArguments: { query: "1 Main Street, New York, NY", invocation_proof: "model-forgery" },
    toolCallId: "tool-call-1",
  };
  const injected = await issuer.inject(evidence);
  assert.notEqual(injected.invocation_proof, "model-forgery");
  const verified = verifyInvocationProof(injected.invocation_proof, KEY, { action: "uber.location_search", args: { query: injected.query } }, NOW);
  assert.match(verified.toolCallIdDigest, /^[a-f0-9]{64}$/u);
  assert.throws(() => verifyInvocationProof(injected.invocation_proof, KEY, { action: "uber.location_search", args: { query: "2 Other Street" } }, NOW), { code: "invocation_args_mismatch" });
});

test("proof action binding is exact", () => {
  const args = { query: "1 Main Street, New York, NY" };
  const proof = proofFor("uber.location_search", args);
  assert.throws(() => verifyInvocationProof(proof, KEY, { action: "uber.location_resolve", args }, NOW), { code: "action_not_authorized" });
});

test("model tool schemas omit coordinates, caller idempotency, and model-required proof", () => {
  const text = JSON.stringify(TOOL_DEFINITIONS.map((tool) => tool.inputSchema));
  for (const forbidden of ["latitude", "longitude", "geocoder", "verifiedAt", "idempotencyKey", "payment_method_id", "uber_monitor_tick"]) assert.equal(text.includes(forbidden), false);
  assert.equal(TOOL_DEFINITIONS.length, 9);
  for (const tool of TOOL_DEFINITIONS.filter((item) => item.name !== "uber_status")) {
    assert.equal(tool.inputSchema.required.includes("invocation_proof"), false);
    assert.equal(tool.inputSchema.properties.invocation_proof["x-openclaw-internal"], true);
  }
});

test("default geocoder fails closed", async () => {
  const geocoder = new DisabledGeocoderAdapter();
  assert.equal((await geocoder.status()).ready, false);
  await assert.rejects(geocoder.search("1 Main Street"), { code: "approved_geocoder_missing" });
});

test("future dispatch is rejected because official Riders API fare is on-demand", () => {
  assert.throws(() => validateChallengeInput({
    estimateRef: "11111111-1111-4111-8111-111111111111",
    paymentAlias: "personal",
    scheduledFor: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    expenseCode: null,
    expenseMemo: null,
  }, NOW), { code: "future_reservation_unsupported" });
});

test("private ledger is 0600, hash chained, and tamper evident", (t) => {
  const directory = tempDirectory(t);
  const filePath = path.join(directory, "ledger.jsonl");
  const ledger = new HashChainedLedger(filePath, () => NOW);
  ledger.append("test.one", { safe: true });
  ledger.append("test.two", { safe: true });
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  assert.equal(ledger.readAll().length, 2);
  const rows = ledger.readAll(); rows[0].evidence.safe = false;
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
  assert.throws(() => ledger.readAll(), { code: "ledger_chain_invalid" });
});

test("rate limiting persists across limiter instances", (t) => {
  const directory = tempDirectory(t);
  const first = new PersistentRateLimiter({ directory, now: () => NOW });
  first.acquire("mutation"); first.acquire("mutation"); first.acquire("mutation");
  const restarted = new PersistentRateLimiter({ directory, now: () => NOW });
  assert.throws(() => restarted.acquire("mutation"), { code: "local_mutation_rate_limit" });
});

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-uber-test-"));
  t.after(() => {
    if (!directory.startsWith(path.join(os.tmpdir(), "openclaw-uber-test-"))) throw new Error("unsafe temp path");
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
