import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OUTLOOK_BUNDLE_ID } from "../definition.mjs";
import { NativeOutlookAdapter, assertInstalledOutlook } from "../native-outlook-adapter.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rico-native-outlook-"));
  fs.chmodSync(root, 0o700);
  const appPath = path.join(root, "Microsoft Outlook.app");
  const contents = path.join(appPath, "Contents");
  const executableDirectory = path.join(contents, "MacOS");
  fs.mkdirSync(executableDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${OUTLOOK_BUNDLE_ID}</string></dict></plist>\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(executableDirectory, "Microsoft Outlook"), "test executable", { mode: 0o700 });
  const calls = [];
  const runner = async (request) => {
    calls.push(request);
    if (request.mode === "accounts") return { ok: true, bundleId: OUTLOOK_BUNDLE_ID, accounts: ["alan.rosa@cvshealth.com"] };
    if (request.mode === "account") return {
      ok: true,
      bundleId: OUTLOOK_BUNDLE_ID,
      senderAccount: request.senderAccount,
      accountMatches: 1,
      workingOffline: false,
      sendCapable: true,
    };
    return {
      ok: true,
      bundleId: OUTLOOK_BUNDLE_ID,
      senderAccount: request.senderAccount,
      accountMatches: 1,
      outlookRecordId: "outlook-record-42",
      to: request.to,
      cc: request.cc,
      bcc: [],
    };
  };
  const adapter = new NativeOutlookAdapter({
    runner,
    appPath,
    claimsDirectory: path.join(root, "claims"),
    sendEnabled: true,
    now: () => new Date("2026-08-15T18:00:00.000Z"),
  });
  return { root, appPath, calls, runner, adapter };
}

function groupPreflight(overrides = {}) {
  return {
    client: "outlook",
    clientBundleId: OUTLOOK_BUNDLE_ID,
    senderAccount: "alan.rosa@cvshealth.com",
    to: ["janet.cummings@cvshealth.com"],
    cc: ["joe@example.com", "alan.a.rosa@gmail.com"],
    bcc: [],
    hasAttachments: false,
    ...overrides,
  };
}

function groupSend(overrides = {}) {
  return {
    client: "outlook",
    clientBundleId: OUTLOOK_BUNDLE_ID,
    from: "alan.rosa@cvshealth.com",
    to: ["janet.cummings@cvshealth.com"],
    cc: ["joe@example.com", "alan.a.rosa@gmail.com"],
    bcc: [],
    subject: "Meeting has been requested by Alan Rosa",
    text: "Janet — this message contains the complete meeting handoff facts and requested next steps in a precise, detailed format.\n\nRico an Autonmous Agent on behalf of Alan Rosa",
    attachments: [],
    idempotencyKey: "rico-group-meeting:abc123",
    requireSourceAccountProof: true,
    noSenderFallback: true,
    ...overrides,
  };
}

test("installed Outlook proof reads the exact bundle identifier", async (t) => {
  const h = fixture();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const proof = await assertInstalledOutlook(h.appPath);
  assert.equal(proof.bundleId, OUTLOOK_BUNDLE_ID);
});

test("group preflight proves exact Outlook account and explicit To/Cc only", async (t) => {
  const h = fixture();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const proof = await h.adapter.preflightEmailSend(groupPreflight());
  assert.equal(proof.ok, true);
  assert.equal(proof.sourceAccountProven, true);
  assert.equal(proof.noSenderFallback, true);
  assert.equal(proof.explicitRecipientsOnly, true);
  assert.deepEqual(proof.to, ["janet.cummings@cvshealth.com"]);
  assert.deepEqual(proof.cc, ["joe@example.com", "alan.a.rosa@gmail.com"]);
  assert.deepEqual(proof.bcc, []);
  assert.equal(h.calls[0].mode, "account");
});

test("send is disabled by default even when Outlook exists", async (t) => {
  const h = fixture();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const disabled = new NativeOutlookAdapter({
    runner: h.runner,
    appPath: h.appPath,
    claimsDirectory: path.join(h.root, "disabled-claims"),
  });
  await assert.rejects(disabled.preflightEmailSend(groupPreflight()), /native_outlook_send_disabled/u);
  await assert.rejects(disabled.sendEmail(groupSend()), /native_outlook_send_disabled/u);
  assert.equal(h.calls.length, 0);
});

test("group send returns an exact proof and stores only hashed claim evidence", async (t) => {
  const h = fixture();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const proof = await h.adapter.sendEmail(groupSend());
  assert.equal(proof.ok, true);
  assert.equal(proof.from, "alan.rosa@cvshealth.com");
  assert.deepEqual(proof.to, ["janet.cummings@cvshealth.com"]);
  assert.deepEqual(proof.cc, ["joe@example.com", "alan.a.rosa@gmail.com"]);
  assert.deepEqual(proof.bcc, []);
  assert.match(proof.messageId, /^outlook-native:[a-f0-9]{64}$/u);
  const files = fs.readdirSync(h.adapter.claimsDirectory);
  assert.equal(files.length, 1);
  const stored = fs.readFileSync(path.join(h.adapter.claimsDirectory, files[0]), "utf8");
  assert.doesNotMatch(stored, /janet|joe|cvshealth|gmail|Meeting has|Rico an/iu);
  assert.match(stored, /"status": "confirmed"/u);
});

test("adapter-level idempotency claim prevents a second Outlook call", async (t) => {
  const h = fixture();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await h.adapter.sendEmail(groupSend());
  await assert.rejects(h.adapter.sendEmail(groupSend()), /native_outlook_idempotency_claim_exists/u);
  assert.equal(h.calls.filter((item) => item.mode === "send").length, 1);
});

test("an uncertain Outlook result remains claimed and cannot be retried", async (t) => {
  const h = fixture();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const uncertain = new NativeOutlookAdapter({
    runner: async (request) => {
      h.calls.push(request);
      if (request.mode === "send") throw Object.assign(new Error("timeout"), { code: "native_outlook_automation_timeout" });
      return h.runner(request);
    },
    appPath: h.appPath,
    claimsDirectory: path.join(h.root, "uncertain-claims"),
    sendEnabled: true,
  });
  await assert.rejects(uncertain.sendEmail(groupSend()), /timeout/u);
  await assert.rejects(uncertain.sendEmail(groupSend()), /native_outlook_idempotency_claim_exists/u);
  assert.equal(fs.readdirSync(uncertain.claimsDirectory).length, 1);
});

test("Bcc and recipient overlap are rejected before Outlook", async (t) => {
  const h = fixture();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await assert.rejects(h.adapter.preflightEmailSend(groupPreflight({ bcc: ["hidden@example.com"] })), /native_outlook_bcc_forbidden/u);
  await assert.rejects(h.adapter.preflightEmailSend(groupPreflight({ cc: ["janet.cummings@cvshealth.com"] })), /native_outlook_recipient_duplicate/u);
  assert.equal(h.calls.length, 0);
});

test("single-recipient shape remains compatible with the existing dispatcher", async (t) => {
  const h = fixture();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const preflight = await h.adapter.preflightEmailSend({
    client: "outlook",
    clientBundleId: OUTLOOK_BUNDLE_ID,
    senderAccount: "alan.rosa@cvshealth.com",
    recipient: "janet.cummings@cvshealth.com",
    hasAttachments: false,
  });
  assert.equal(preflight.recipient, "janet.cummings@cvshealth.com");
  assert.equal(Object.prototype.hasOwnProperty.call(preflight, "cc"), false);
  const proof = await h.adapter.sendEmail(groupSend({
    to: "janet.cummings@cvshealth.com",
    cc: [],
    idempotencyKey: "rico-person-email:single123",
  }));
  assert.equal(proof.to, "janet.cummings@cvshealth.com");
  assert.equal(Object.prototype.hasOwnProperty.call(proof, "cc"), false);
});
