import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MacOSOpenTableCredentialProvider } from "../keychain.mjs";
import { OpenTableStateStore } from "../state-store.mjs";
import { sha256 } from "../canonical.mjs";
import { FIXED_NOW } from "./helpers.mjs";

test("Keychain provider uses exact service/account and wipes captured stdout", async () => {
  const stdout = Buffer.from("super-secret\n");
  let seenArgs;
  const provider = new MacOSOpenTableCredentialProvider({
    execFileFn: async (command, args, options) => {
      assert.equal(command, "/usr/bin/security");
      seenArgs = args;
      assert.deepEqual(options.env, { PATH: "/usr/bin:/bin" });
      return { stdout };
    },
  });
  const result = await provider.withSecret(async (secret) => secret.toString("utf8"));
  assert.equal(result, "super-secret");
  assert.deepEqual(seenArgs, ["find-generic-password", "-s", "openclaw-opentable", "-a", "alan", "-w"]);
  assert.ok(stdout.every((byte) => byte === 0));
  assert.ok(!seenArgs.join(" ").includes("super-secret"));
});

test("private state store enforces challenge binding, one-time use, and mutation dedupe", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ot-state-"));
  let now = new Date(FIXED_NOW);
  const store = new OpenTableStateStore(root, () => now);
  const principal = { bindingDigest: sha256("principal-a"), messageDigest: sha256("source-message"), runDigest: sha256("source-run") };
  const challenge = store.createChallenge("booking-preview", { payload: { rid: 1 }, principal, ttlMs: 60_000 });
  const confirmingPrincipal = {
    bindingDigest: principal.bindingDigest,
    messageDigest: sha256("confirmation-message"),
    messageBodyDigest: sha256(challenge.challenge),
    runDigest: sha256("confirmation-run"),
  };
  const file = path.join(root, "booking-preview", `${challenge.id}.json`);
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => store.requireActive("booking-preview", challenge.id, { confirmation: "HOLD 000000", principal: confirmingPrincipal }), (error) => error.code === "confirmation_mismatch");
  assert.equal(store.requireActive("booking-preview", challenge.id, { confirmation: challenge.challenge, principal: confirmingPrincipal }).id, challenge.id);
  store.consume(challenge);
  assert.throws(() => store.requireActive("booking-preview", challenge.id, { confirmation: challenge.challenge, principal: confirmingPrincipal }), (error) => error.code === "challenge_consumed");

  const first = store.reserveMutation("book", "entity-a");
  const second = store.reserveMutation("book", "entity-a");
  assert.equal(first.newlyReserved, true);
  assert.equal(second.newlyReserved, false);
  assert.equal(first.requestId, second.requestId);
  store.completeMutation(first, "confirmed", { ok: true });
  assert.match(fs.readFileSync(path.join(root, "ledger.jsonl"), "utf8"), /mutation\.confirmed/u);

  const expiring = store.createChallenge("cancel-preview", { payload: { rid: 1 }, principal, ttlMs: 1_000 });
  now = new Date(FIXED_NOW.getTime() + 1_001);
  assert.throws(() => store.requireActive("cancel-preview", expiring.id, { confirmation: expiring.challenge, principal: { ...confirmingPrincipal, messageBodyDigest: sha256(expiring.challenge) } }), (error) => error.code === "challenge_expired");
});
