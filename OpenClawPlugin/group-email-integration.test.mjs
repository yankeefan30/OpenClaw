import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createGroupEmailExecutionRegistry,
  RICO_GROUP_EMAIL_TOOL_DESCRIPTION,
  RICO_GROUP_EMAIL_TOOL_PARAMETERS,
} from "./group-email-integration.js";
import { messageHash } from "./policy.js";
import { RICO_GROUP_EMAIL_TOOL_DEFINITION } from "../RicoEmailGovernance/group-email-tool.mjs";

function grant(overrides = {}) {
  const body = "@rico email Janet and copy Joe, with a complete technical summary.";
  return {
    runId: "run-1",
    toolCallId: "call-1",
    sessionKey: "agent:rico-shared:imessage:group:42",
    sessionId: "session-1",
    senderHandle: "+16469433060",
    senderIsOwner: true,
    groupTarget: "chat_id:42",
    groupRevision: 7,
    participantHandles: ["+16469433060", "+12125550120"],
    origin: {
      messageId: "message-1",
      conversationId: "conversation-42",
      body,
      bodyHash: messageHash(body),
      receivedAt: "2026-08-15T18:00:00.000Z",
    },
    ...overrides,
  };
}

function runtime(overrides = {}) {
  return {
    toolCallId: "call-1",
    ...overrides,
  };
}

test("tool registration is context-independent and execution authority stays in the run-bound gate", () => {
  const source = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "index.js"), "utf8");
  const registration = source.slice(source.indexOf("api.registerTool({"), source.indexOf("api.registerGatewayMethod"));
  assert.match(registration, /name: RICO_GROUP_EMAIL_TOOL_NAME/u);
  assert.match(registration, /runtimeContext: \{ toolCallId \}/u);
  assert.doesNotMatch(registration, /toolContext|senderIsOwner|requesterSenderId/u);
  const toolGate = source.slice(source.indexOf('api.on("before_tool_call"'), source.indexOf('api.on("agent_end"'));
  assert.ok(toolGate.indexOf("event.toolName === RICO_GROUP_EMAIL_TOOL_NAME") <
    toolGate.indexOf('senderContext.isOwner === true && senderContext.conversationType === "direct"'));
  assert.match(toolGate, /Governed group email is available only to the exact owner in a verified group turn/u);
});

test("registered model schema stays byte-for-byte aligned with governance", () => {
  assert.equal(RICO_GROUP_EMAIL_TOOL_DESCRIPTION, RICO_GROUP_EMAIL_TOOL_DEFINITION.description);
  assert.deepEqual(RICO_GROUP_EMAIL_TOOL_PARAMETERS, RICO_GROUP_EMAIL_TOOL_DEFINITION.inputSchema);
  assert.doesNotMatch(JSON.stringify(RICO_GROUP_EMAIL_TOOL_PARAMETERS), /recipientEmail|senderAccount|bcc/iu);
});

test("one run/toolCall grant becomes one exact principal proof", () => {
  const registry = createGroupEmailExecutionRegistry();
  assert.equal(registry.authorize(grant()), true);
  assert.equal(registry.authorize(grant()), false);
  const origin = registry.consume(runtime());
  assert.equal(origin.source, "rico-recipient-guard/v5");
  assert.equal(origin.senderHandle, "+16469433060");
  assert.throws(() => registry.consume(runtime()), /single_use_grant_unavailable/u);
  const proof = registry.verifyInboundPrincipal({
    channel: "imessage",
    messageId: origin.messageId,
    conversationId: origin.conversationId,
    expectedBodyHash: origin.bodyHash,
    expectedGroupTarget: origin.groupTarget,
    requireGroup: true,
    requireAuthenticated: true,
  });
  assert.deepEqual(proof.participantHandles, ["+12125550120", "+16469433060"]);
  assert.throws(() => registry.verifyInboundPrincipal({
    channel: "imessage", messageId: origin.messageId, conversationId: origin.conversationId,
    expectedBodyHash: origin.bodyHash, expectedGroupTarget: origin.groupTarget,
    requireGroup: true, requireAuthenticated: true,
  }), /principal_proof_unavailable/u);
});

test("only one exact gate-minted owner grant can satisfy a static tool execution", () => {
  const registry = createGroupEmailExecutionRegistry();
  assert.throws(() => registry.authorize(grant({ senderIsOwner: false })), /group_email_grant_invalid/u);
  assert.throws(() => registry.authorize(grant({
    sessionKey: "agent:rico-shared:imessage:direct:owner",
  })), /group_email_grant_invalid/u);
  assert.throws(() => registry.authorize(grant({ groupRevision: 0 })));
  assert.throws(() => registry.authorize(grant({ origin: { ...grant().origin, bodyHash: "f".repeat(64) } })));
  registry.authorize(grant());
  assert.throws(() => registry.consume({ ...runtime(), sessionId: "untrusted" }), /execution_context_unproven/u);

  const ambiguous = createGroupEmailExecutionRegistry();
  ambiguous.authorize(grant());
  ambiguous.authorize(grant({ runId: "run-2" }));
  assert.throws(() => ambiguous.consume(runtime()), /single_use_grant_unavailable/u);
});

test("run cleanup revokes an unconsumed grant", () => {
  const registry = createGroupEmailExecutionRegistry();
  registry.authorize(grant());
  assert.equal(registry.forgetRun("run-1"), 1);
  assert.throws(() => registry.consume(runtime()), /single_use_grant_unavailable/u);
});
