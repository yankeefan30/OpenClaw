import assert from "node:assert/strict";
import test from "node:test";
import { personAuthorization } from "../../RicoEmailGovernance/tests/fixtures.mjs";
import { authorizeEmailRecipient, parseEmailAddress } from "../email-allowlist.mjs";
import { callTool } from "../tools.mjs";

function policy(identities = [], paused = false) {
  return { schemaVersion: 2, paused, identities };
}

const ownerIdentity = {
  target: "+16469433060",
  kind: "individual",
  access: "owner",
  requireMention: false,
  autoReply: true,
  quietStart: 0,
  quietEnd: 0,
};

const janet = personAuthorization();

test("parses email addresses and rejects non-email targets", () => {
  assert.equal(parseEmailAddress("Janet@Example.com"), "janet@example.com");
  assert.throws(() => parseEmailAddress("+16469433060"), { code: "target_invalid" });
  assert.throws(() => parseEmailAddress("not-an-email"), { code: "target_invalid" });
});

test("email allowlist accepts authorized people and owner accounts", () => {
  const authorized = authorizeEmailRecipient({
    policy: policy([ownerIdentity]),
    authorizations: [janet],
    address: "janet@example.com",
  });
  assert.equal(authorized.ok, true);
  assert.equal(authorized.kind, "person-authorization");
  assert.equal(authorized.senderAccount, "alan.a.rosa@gmail.com");

  const self = authorizeEmailRecipient({
    policy: policy([ownerIdentity]),
    authorizations: [janet],
    address: "alan.a.rosa@gmail.com",
  });
  assert.equal(self.kind, "owner");
  assert.equal(self.senderAccount, "alan.a.rosa@gmail.com");
});

test("recipient-guard email identities are Mail-only, not Outlook", () => {
  const guardEmail = {
    target: "ana@example.com",
    kind: "individual",
    access: "approved",
    requireMention: true,
    autoReply: true,
    quietStart: 0,
    quietEnd: 0,
  };
  assert.equal(authorizeEmailRecipient({
    policy: policy([ownerIdentity, guardEmail]),
    authorizations: [],
    address: "ana@example.com",
  }).kind, "recipient-guard");
  assert.throws(() => authorizeEmailRecipient({
    policy: policy([ownerIdentity, guardEmail]),
    authorizations: [],
    address: "ana@example.com",
    requireGovernedOutlook: true,
  }), { code: "recipient_not_allowlisted" });
});

test("email allowlist rejects strangers, paused policy, and sender mismatch", () => {
  assert.throws(() => authorizeEmailRecipient({
    policy: policy([ownerIdentity]),
    authorizations: [janet],
    address: "stranger@example.com",
  }), { code: "recipient_not_allowlisted" });
  assert.throws(() => authorizeEmailRecipient({
    policy: policy([ownerIdentity], true),
    authorizations: [janet],
    address: "janet@example.com",
  }), { code: "paused" });
  assert.throws(() => authorizeEmailRecipient({
    policy: policy([ownerIdentity]),
    authorizations: [janet],
    address: "janet@example.com",
    from: "alan.rosa@cvshealth.com",
  }), { code: "email_sender_not_allowed" });
});

test("Outlook send requires a governed authorization and never calls the adapter for strangers", async () => {
  const sends = [];
  const runtime = {
    policy: policy([ownerIdentity]),
    emailAuthorizations: [janet],
    localApps: {
      async outlookSend(request) {
        sends.push(request);
        return { ok: true, client: "outlook", to: request.to, from: request.from, messageId: "outlook-1" };
      },
    },
  };
  await assert.rejects(
    callTool(runtime, "rico_outlook_send", {
      to: "stranger@example.com",
      subject: "Hello",
      text: "This should never send.",
    }),
    { code: "recipient_not_allowlisted" },
  );
  assert.equal(sends.length, 0);

  const allowed = await callTool(runtime, "rico_outlook_send", {
    to: "janet@example.com",
    subject: "Hello Janet",
    text: "Governed Outlook test body.",
    idempotencyKey: "test-outlook-1",
  });
  assert.equal(allowed.ok, true);
  assert.deepEqual(sends, [{
    to: "janet@example.com",
    from: "alan.a.rosa@gmail.com",
    subject: "Hello Janet",
    text: "Governed Outlook test body.",
    idempotencyKey: "test-outlook-1",
  }]);
});

test("Mail send rejects strangers without invoking AppleScript", async () => {
  const sends = [];
  const runtime = {
    policy: policy([ownerIdentity]),
    emailAuthorizations: [janet],
    localApps: {
      async mailSend(request) {
        sends.push(request);
        return { ok: true, client: "mail", to: request.to, subject: request.subject };
      },
    },
  };
  await assert.rejects(
    callTool(runtime, "rico_mail_send", {
      to: "stranger@example.com",
      subject: "Hello",
      text: "Nope",
    }),
    { code: "recipient_not_allowlisted" },
  );
  assert.equal(sends.length, 0);

  const allowed = await callTool(runtime, "rico_mail_send", {
    to: "alan.a.rosa@gmail.com",
    subject: "Self note",
    text: "Owner self-send is allowed.",
  });
  assert.equal(allowed.ok, true);
  assert.equal(sends[0].to, "alan.a.rosa@gmail.com");
});
