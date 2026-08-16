import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { GroupEmailBroker } from "../group-email-broker.mjs";
import { EMAIL_SIGNATURE, OUTLOOK_BUNDLE_ID } from "../definition.mjs";
import { DeliveryLedger } from "../ledger.mjs";
import { sha256 } from "../policy.mjs";
import { harness, personAuthorization } from "./fixtures.mjs";

const ACTOR = "+16469433060";
const JOE = "+12125550120";
const EXTRA_GROUP_MEMBER = "+12125550130";

function profile({ id, hashCharacter, name, handle, email, sender = "alan.rosa@cvshealth.com", attachmentsAllowed = false }) {
  return personAuthorization({
    profileId: id,
    contactIdentifierHash: hashCharacter.repeat(64),
    displayName: name,
    principal: { handle },
    email: { enabled: true, attachmentsAllowed, recipientEmail: email, senderAccount: sender },
  });
}

function profiles(overrides = {}) {
  return [
    profile({ id: "person-janet", hashCharacter: "a", name: "Janet Cummings", handle: "+12145312001", email: "janet.cummings@cvshealth.com", ...overrides.janet }),
    profile({ id: "person-joe", hashCharacter: "b", name: "Joe Example", handle: JOE, email: "joe@example.com", ...overrides.joe }),
    profile({ id: "person-alan", hashCharacter: "d", name: "Alan Rosa", handle: ACTOR, email: "alan.a.rosa@gmail.com", ...overrides.alan }),
  ];
}

function groupAuthorization(overrides = {}) {
  return {
    schema: "rico.group-email-authorization",
    schemaVersion: 1,
    target: "chat_id:42",
    participants: [ACTOR, JOE, EXTRA_GROUP_MEMBER],
    revision: 3,
    authorizedAt: "2026-08-15T17:00:00.000Z",
    ...overrides,
  };
}

function inbound(overrides = {}) {
  return {
    messageId: "group-message-1",
    conversationId: "chat-guid-42",
    body: "@rico email Janet with the technical summary and copy Joe and me.",
    ...overrides,
  };
}

function draft(overrides = {}) {
  return {
    subject: "Technical summary and requested follow-up",
    body: "Janet — the requested technical summary is set out below with the relevant facts, limitations, and next steps stated precisely so the recipients have a complete and accurate record.",
    attachments: [],
    ...overrides,
  };
}

function directives() {
  return [
    { role: "to", mention: "Janet" },
    { role: "cc", mention: "Joe" },
    { role: "cc", mention: "me" },
  ];
}

function groupHarness({ profileSet = profiles(), group = groupAuthorization(), principalProof, preflightProof, sendProof } = {}) {
  const h = harness();
  const calls = { principal: [], preflight: [], send: [] };
  const principalAdapter = {
    verifyInboundPrincipal: async (request) => {
      calls.principal.push(request);
      if (principalProof) return principalProof(request);
      return {
        ok: true,
        channel: "imessage",
        direction: "inbound",
        group: true,
        messageId: request.messageId,
        conversationId: request.conversationId,
        groupTarget: group.target,
        senderHandle: ACTOR,
        participantHandles: group.participants,
        bodyHash: request.expectedBodyHash,
        receivedAt: "2026-08-15T17:31:00.000Z",
        authenticationSource: "openclaw-gateway-exact-principal",
      };
    },
  };
  const outlookAdapter = {
    preflightEmailSend: async (request) => {
      calls.preflight.push(request);
      if (preflightProof) return preflightProof(request);
      return {
        ok: true,
        client: "outlook",
        clientBundleId: OUTLOOK_BUNDLE_ID,
        senderAccount: request.senderAccount,
        to: request.to,
        cc: request.cc,
        bcc: [],
        outlookClientProven: true,
        sourceAccountProven: true,
        recipientProven: true,
        noSenderFallback: true,
        idempotentSends: true,
        explicitRecipientsOnly: true,
        attachmentsSupported: true,
      };
    },
    sendEmail: async (request) => {
      calls.send.push(request);
      if (sendProof) return sendProof(request);
      return {
        ok: true,
        client: "outlook",
        clientBundleId: OUTLOOK_BUNDLE_ID,
        from: request.from,
        to: request.to,
        cc: request.cc,
        bcc: [],
        messageId: `outlook-group-${calls.send.length}`,
        sourceAccountProven: true,
        noSenderFallback: true,
        explicitRecipientsOnly: true,
      };
    },
  };
  const ledger = new DeliveryLedger(path.join(h.root, "group-claims"), () => new Date("2026-08-15T17:32:00.000Z"));
  const broker = new GroupEmailBroker({ principalAdapter, outlookAdapter, ledger });
  return { ...h, profileSet, group, calls, broker };
}

test("group email sends only explicitly mentioned approved To/Cc recipients", async (t) => {
  const h = groupHarness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const result = await h.broker.send({
    inbound: inbound(),
    groupAuthorization: h.group,
    authorizations: h.profileSet,
    recipientDirectives: directives(),
    draft: draft(),
  });
  assert.equal(result.status, "sent");
  assert.equal(h.calls.send.length, 1);
  assert.deepEqual(h.calls.send[0].to, ["janet.cummings@cvshealth.com"]);
  assert.deepEqual(new Set(h.calls.send[0].cc), new Set(["joe@example.com", "alan.a.rosa@gmail.com"]));
  assert.equal(h.calls.send[0].to.includes(EXTRA_GROUP_MEMBER), false);
  assert.deepEqual(h.calls.send[0].bcc, []);
  assert.equal(h.calls.send[0].text.endsWith(EMAIL_SIGNATURE), true);
});

test("group membership never becomes an implicit recipient list", async (t) => {
  const h = groupHarness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await assert.rejects(h.broker.send({
    inbound: inbound(),
    groupAuthorization: h.group,
    authorizations: h.profileSet,
    recipientDirectives: [],
    draft: draft(),
  }), /group_recipient_directives_invalid/u);
  assert.equal(h.calls.preflight.length, 0);
  assert.equal(h.calls.send.length, 0);
});

test("a recipient directive must be a literal mention in the authenticated message", async (t) => {
  const h = groupHarness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await assert.rejects(h.broker.send({
    inbound: inbound({ body: "@rico email Janet with the complete summary." }),
    groupAuthorization: h.group,
    authorizations: h.profileSet,
    recipientDirectives: [{ role: "to", mention: "Janet" }, { role: "cc", mention: "Joe" }],
    draft: draft(),
  }), /group_recipient_not_literally_mentioned/u);
  assert.equal(h.calls.preflight.length, 0);
});

test("ambiguous first names fail closed instead of choosing an address", async (t) => {
  const profileSet = [...profiles(), profile({
    id: "person-other-janet",
    hashCharacter: "e",
    name: "Janet Smith",
    handle: "+12125550199",
    email: "other-janet@example.com",
  })];
  const h = groupHarness({ profileSet });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await assert.rejects(h.broker.send({
    inbound: inbound(),
    groupAuthorization: h.group,
    authorizations: h.profileSet,
    recipientDirectives: directives(),
    draft: draft(),
  }), /group_recipient_ambiguous/u);
  assert.equal(h.calls.preflight.length, 0);
});

test("changed live group membership blocks before Outlook", async (t) => {
  const h = groupHarness({ principalProof: (request) => ({
    ok: true,
    channel: "imessage",
    direction: "inbound",
    group: true,
    messageId: request.messageId,
    conversationId: request.conversationId,
    groupTarget: "chat_id:42",
    senderHandle: ACTOR,
    participantHandles: [ACTOR, JOE],
    bodyHash: request.expectedBodyHash,
    receivedAt: "2026-08-15T17:31:00.000Z",
    authenticationSource: "openclaw-gateway-exact-principal",
  }) });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await assert.rejects(h.broker.send({
    inbound: inbound(), groupAuthorization: h.group, authorizations: h.profileSet,
    recipientDirectives: directives(), draft: draft(),
  }), /group_inbound_membership_mismatch/u);
  assert.equal(h.calls.preflight.length, 0);
});

test("the primary To authorization selects From while copied people may prefer another sender", async (t) => {
  const h = groupHarness({ profileSet: profiles({
    joe: { sender: "alan.a.rosa@gmail.com" },
    alan: { sender: "alan.a.rosa@gmail.com" },
  }) });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const result = await h.broker.send({
    inbound: inbound(), groupAuthorization: h.group, authorizations: h.profileSet,
    recipientDirectives: directives(), draft: draft(),
  });
  assert.equal(result.status, "sent");
  assert.equal(h.calls.send[0].from, "alan.rosa@cvshealth.com");
});

test("multiple To recipients must agree on one exact sender account", async (t) => {
  const h = groupHarness({ profileSet: profiles({ joe: { sender: "alan.a.rosa@gmail.com" } }) });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await assert.rejects(h.broker.send({
    inbound: inbound({ body: "@rico email Janet and Joe with the technical summary." }),
    groupAuthorization: h.group,
    authorizations: h.profileSet,
    recipientDirectives: [
      { role: "to", mention: "Janet" },
      { role: "to", mention: "Joe" },
    ],
    draft: draft(),
  }), /group_to_sender_account_mismatch/u);
  assert.equal(h.calls.preflight.length, 0);
});

test("attachments require independent permission from every To/Cc recipient", async (t) => {
  const h = groupHarness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await assert.rejects(h.broker.send({
    inbound: inbound(), groupAuthorization: h.group, authorizations: h.profileSet,
    recipientDirectives: directives(),
    draft: draft({ attachments: [{ path: "/tmp/evidence.pdf", mime: "application/pdf", byteSize: 12, sha256: "a".repeat(64) }] }),
  }), /group_recipient_attachments_disabled/u);
  assert.equal(h.calls.preflight.length, 0);
});

test("private-source provenance is rejected before identity or Outlook access", async (t) => {
  const h = groupHarness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await assert.rejects(h.broker.send({
    inbound: inbound(), groupAuthorization: h.group, authorizations: h.profileSet,
    recipientDirectives: directives(),
    draft: draft({ body: "I reviewed your recorded meeting in Limitless and pulled the requested details from the transcript. This is intentionally long enough to otherwise pass the detailed email validation requirement." }),
  }), /private_context_provenance_disclosure_denied/u);
  assert.equal(h.calls.principal.length, 0);
  assert.equal(h.calls.preflight.length, 0);
});

test("group meeting handoff emails Janet and copies only explicitly mentioned people", async (t) => {
  const h = groupHarness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const request = inbound({
    messageId: "group-meeting-1",
    body: "@rico please arrange a meeting through Janet and copy Joe and me on the email.",
  });
  const result = await h.broker.sendMeetingHandoff({
    inbound: request,
    groupAuthorization: h.group,
    authorizations: h.profileSet,
    recipientDirectives: directives(),
  });
  assert.equal(result.status, "sent");
  const sent = h.calls.send[0];
  assert.deepEqual(sent.to, ["janet.cummings@cvshealth.com"]);
  assert.deepEqual(new Set(sent.cc), new Set(["joe@example.com", "alan.a.rosa@gmail.com"]));
  assert.equal(sent.subject, "Meeting has been requested by Alan Rosa");
  assert.match(sent.text, /Alan Rosa requested that a meeting be arranged/u);
  assert.match(sent.text, /August 15, 2026/u);
  assert.doesNotMatch(sent.text, /conversation|recording|transcript|Limitless|PLAUD/iu);
  assert.equal(sent.text.endsWith(EMAIL_SIGNATURE), true);
});

test("group meeting handoff requires Janet as the sole To recipient", async (t) => {
  const h = groupHarness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  await assert.rejects(h.broker.sendMeetingHandoff({
    inbound: inbound({ body: "@rico please arrange a meeting through Janet and Joe." }),
    groupAuthorization: h.group,
    authorizations: h.profileSet,
    recipientDirectives: [{ role: "cc", mention: "Janet" }, { role: "to", mention: "Joe" }],
  }), /meeting_handoff_requires_janet_as_sole_to_recipient/u);
  assert.equal(h.calls.send.length, 0);
});

test("replay cannot duplicate a group email", async (t) => {
  const h = groupHarness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const request = {
    inbound: inbound(), groupAuthorization: h.group, authorizations: h.profileSet,
    recipientDirectives: directives(), draft: draft(),
  };
  assert.equal((await h.broker.send(request)).status, "sent");
  assert.equal((await h.broker.send(request)).status, "already-claimed");
  assert.equal(h.calls.send.length, 1);
});
