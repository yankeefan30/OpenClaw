import assert from "node:assert/strict";
import test from "node:test";
import { parseCredentialBundle } from "../credentials.mjs";
import { verifyInvocationProof } from "../invocation-proof.mjs";
import { InvocationProofIssuer } from "../proof-issuer.mjs";
import { BufferCredentialProvider, HMAC_KEY, FIXED_NOW, proof, validBundle } from "./helpers.mjs";

test("reviewed Consumer API v2 Keychain bundle validates", () => {
  const bundle = parseCredentialBundle(Buffer.from(JSON.stringify(validBundle())), FIXED_NOW);
  assert.equal(bundle.environment, "production");
  assert.equal(bundle.apiFamily, "consumer-v2");
  assert.ok(bundle.approval.approvedCapabilities.includes("book"));
});

for (const [name, override, code] of [
  ["disabled", { enabled: false }, "opentable_disabled"],
  ["Voice AI mismatch", { apiFamily: "inhouse-v1" }, "api_family_not_approved"],
  ["unofficial API host", { apiBaseUrl: "https://example.com" }, "api_base_url_invalid"],
  ["missing app review", { approval: { appReviewed: false } }, "partner_approval_missing"],
  ["wrong interface", { approval: { approvedInterface: "voice" } }, "interface_not_approved"],
  ["expired", { approval: { expiresAt: "2026-08-15T15:59:59.000Z" } }, "partner_approval_expired"],
]) {
  test(`credential bundle fails closed when ${name}`, () => {
    assert.throws(() => parseCredentialBundle(Buffer.from(JSON.stringify(validBundle(override))), FIXED_NOW), (error) => error.code === code);
  });
}

test("invocation proof binds owner, action, and expiry", () => {
  const token = proof("booking.preview");
  const verified = verifyInvocationProof(token, HMAC_KEY, "booking.preview", FIXED_NOW);
  assert.match(verified.principalDigest, /^[a-f0-9]{64}$/u);
  assert.throws(() => verifyInvocationProof(token, HMAC_KEY, "booking.confirm", FIXED_NOW), (error) => error.code === "action_not_authorized");
  assert.throws(() => verifyInvocationProof(token, HMAC_KEY, "booking.preview", new Date(FIXED_NOW.getTime() + 180_001)), (error) => error.code === "invocation_proof_expired");
});

test("invocation proof rejects signature tampering", () => {
  const token = proof("availability.search");
  const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
  assert.throws(() => verifyInvocationProof(tampered, HMAC_KEY, "availability.search", FIXED_NOW), (error) => error.code === "invocation_proof_invalid");
});

test("recipient-guard seam issues one action-scoped owner proof without exposing the handle", async () => {
  const issuer = new InvocationProofIssuer({ credentialProvider: new BufferCredentialProvider(), now: () => FIXED_NOW });
  const handle = "+16465550123";
  const token = await issuer.issue({
    guardContract: "rico-recipient-guard/v5",
    authenticatedOwner: true,
    principalHandle: handle,
    messageId: "message-1",
    messageBody: "find a table",
    conversationId: "chat-1",
    runId: "run-1",
    channel: "imessage",
    action: "booking.preview",
  });
  assert.ok(!token.includes(handle));
  assert.doesNotThrow(() => verifyInvocationProof(token, HMAC_KEY, "booking.preview", FIXED_NOW));
  assert.throws(() => verifyInvocationProof(token, HMAC_KEY, "booking.confirm", FIXED_NOW), (error) => error.code === "action_not_authorized");
  await assert.rejects(issuer.issue({
    guardContract: "rico-recipient-guard/v5",
    authenticatedOwner: false,
    principalHandle: handle,
    messageId: "message-1",
    messageBody: "find a table",
    conversationId: "chat-1",
    runId: "run-1",
    channel: "imessage",
    action: "booking.preview",
  }), (error) => error.code === "issuer_evidence_not_authorized");
});

test("proof issuer rejects legacy v4 guard evidence", async () => {
  const issuer = new InvocationProofIssuer({ credentialProvider: new BufferCredentialProvider(), now: () => FIXED_NOW });
  await assert.rejects(issuer.issue({
    guardContract: "rico-recipient-guard/v4",
    authenticatedOwner: true,
    principalHandle: "+16465550123",
    messageId: "message-2",
    messageBody: "find a table",
    conversationId: "chat-1",
    runId: "run-2",
    channel: "imessage",
    action: "booking.preview",
  }), (error) => error.code === "issuer_evidence_not_authorized");
});
