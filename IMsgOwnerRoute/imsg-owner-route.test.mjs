import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createOwnerSelfChatRouteCache,
  createRoutePolicyProvider,
  isLiteralLeadingRicoMention,
  normalizeHandle,
  observeOwnerSelfChat,
  promoteOwnerCommand,
  rewriteOwnerSelfChatSend,
  buildImsgCliSendArgs,
  rpcResultFromImsgCliSend,
  trackRpcRequest,
  transformRequestLine,
  transformResponseLine,
  transformRpcFrame,
  validateRoutePolicy,
} from "./imsg-owner-route.mjs";

const owner = "+15555550100";
const activation = Date.parse("2026-08-15T12:00:00Z");
const policy = validateRoutePolicy({
  schemaVersion: 1,
  enabled: true,
  ownerHandles: [owner],
  allowedGroupChatIds: [24],
  notBeforeMs: activation,
});

function ownerMessage(overrides = {}) {
  return {
    id: 101,
    guid: "owner-command-guid",
    chat_id: 24,
    is_group: true,
    is_from_me: true,
    sender: owner,
    destination_caller_id: owner,
    text: "@rico summarize this thread",
    created_at: "2026-08-15T12:00:01Z",
    ...overrides,
  };
}

function ownerSelfChatMessage(overrides = {}) {
  return ownerMessage({
    chat_id: 77,
    is_group: false,
    text: "@rico are you there?",
    ...overrides,
  });
}

function ownerSend(overrides = {}, method = "send") {
  return {
    jsonrpc: "2.0",
    id: 201,
    method,
    params: {
      to: owner,
      text: "Yes, I am here.",
      service: "imessage",
      transport: "applescript",
      reply_to: "historical-thread-guid",
      ...overrides,
    },
  };
}

test("normalizes exact phone and service-prefixed owner handles", () => {
  assert.equal(normalizeHandle("sms:(555) 555-0100"), owner);
  assert.equal(normalizeHandle("MAILTO:Owner@Example.com"), "owner@example.com");
});

test("requires a literal leading Rico command", () => {
  assert.equal(isLiteralLeadingRicoMention(" @RICO: do the work"), true);
  assert.equal(isLiteralLeadingRicoMention("hello @rico"), false);
  assert.equal(isLiteralLeadingRicoMention("@ricochet"), false);
});

test("promotes only the exact owner command in the exact approved group", () => {
  const message = ownerMessage();
  const promoted = promoteOwnerCommand(message, policy);
  assert.notEqual(promoted, message);
  assert.equal(promoted.is_from_me, false);
  assert.equal(promoted.guid, message.guid);
  assert.equal(promoted.sender, message.sender);
  assert.equal(promoted.destination_caller_id, message.destination_caller_id);
});

test("fails closed for all near misses", () => {
  const cases = [
    ownerMessage({ chat_id: 25 }),
    ownerMessage({ sender: "+15555550101" }),
    ownerMessage({ destination_caller_id: "+15555550101" }),
    ownerMessage({ is_group: false }),
    ownerMessage({ is_from_me: false }),
    ownerMessage({ text: "hello @rico" }),
    ownerMessage({ text: "@ricochet do this" }),
    ownerMessage({ guid: undefined, text: "not a command" }),
  ];
  for (const message of cases) assert.equal(promoteOwnerCommand(message, policy), message);
});

test("transforms live message notifications and leaves other frames intact", () => {
  const methods = new Map();
  const notification = { jsonrpc: "2.0", method: "message", params: { message: ownerMessage(), cursor: "next" } };
  const transformed = transformRpcFrame(notification, methods, policy);
  assert.equal(transformed.params.message.is_from_me, false);
  assert.equal(transformed.params.cursor, "next");
  const legacy = { jsonrpc: "2.0", method: "message", params: ownerMessage() };
  assert.equal(transformRpcFrame(legacy, methods, policy).params.is_from_me, false);
  const unrelated = { jsonrpc: "2.0", method: "error", params: { message: "test" } };
  assert.equal(transformRpcFrame(unrelated, methods, policy), unrelated);
});

test("live notifications also respect the activation fence", () => {
  const methods = new Map();
  for (const message of [
    ownerMessage({ created_at: "2026-08-15T11:59:59Z" }),
    ownerMessage({ created_at: undefined }),
  ]) {
    const notification = { jsonrpc: "2.0", method: "message", params: { message } };
    assert.equal(transformRpcFrame(notification, methods, policy).params.message.is_from_me, true);
  }
});

test("transforms catchup history only for a tracked messages.history response", () => {
  const methods = new Map();
  trackRpcRequest({ jsonrpc: "2.0", id: 7, method: "messages.history", params: {} }, methods);
  const response = {
    jsonrpc: "2.0",
    id: 7,
    result: { messages: [ownerMessage(), ownerMessage({ chat_id: 25 })] },
  };
  const transformed = transformRpcFrame(response, methods, policy);
  assert.equal(transformed.result.messages[0].is_from_me, false);
  assert.equal(transformed.result.messages[1].is_from_me, true);
  assert.equal(methods.size, 0);

  const untracked = { ...response, id: 8 };
  assert.equal(transformRpcFrame(untracked, methods, policy), untracked);
});

test("catchup never promotes owner commands from before route activation", () => {
  const methods = new Map();
  trackRpcRequest({ jsonrpc: "2.0", id: 9, method: "messages.history", params: {} }, methods);
  const stale = ownerMessage({ created_at: "2026-08-15T11:59:59Z" });
  const missingTimestamp = ownerMessage({ created_at: undefined });
  const response = { jsonrpc: "2.0", id: 9, result: { messages: [stale, missingTimestamp] } };
  const transformed = transformRpcFrame(response, methods, policy);
  assert.equal(transformed.result.messages[0].is_from_me, true);
  assert.equal(transformed.result.messages[1].is_from_me, true);
});

test("rewrites an exact owner direct self-chat reply onto the owner handle", () => {
  const now = activation + 2_000;
  const routes = createOwnerSelfChatRouteCache({ ttlMs: 60_000, now: () => now });
  const methods = new Map();
  const notification = {
    jsonrpc: "2.0",
    method: "message",
    params: { message: ownerSelfChatMessage(), cursor: "self-chat-cursor" },
  };

  const observed = transformRpcFrame(notification, methods, policy, routes, now);
  assert.equal(observed, notification);
  assert.equal(routes.size, 1);

  const request = ownerSend();
  const rewritten = rewriteOwnerSelfChatSend(request, policy, routes, now + 1);
  assert.notEqual(rewritten, request);
  assert.equal(rewritten.params.to, owner);
  assert.equal(Object.hasOwn(rewritten.params, "chat_id"), false);
  assert.equal(Object.hasOwn(rewritten.params, "reply_to"), false);
  assert.equal(rewritten.params.text, request.params.text);
  assert.equal(rewritten.params.service, "imessage");
  assert.equal(request.params.to, owner);
  assert.equal(request.params.reply_to, "historical-thread-guid");
});

test("strips owner self-chat thread metadata even without a live chat-id route", () => {
  const request = ownerSend();
  const rewritten = rewriteOwnerSelfChatSend(request, policy, createOwnerSelfChatRouteCache({ ttlMs: 60_000 }));
  assert.notEqual(rewritten, request);
  assert.equal(rewritten.params.to, owner);
  assert.equal(Object.hasOwn(rewritten.params, "chat_id"), false);
  assert.equal(Object.hasOwn(rewritten.params, "reply_to"), false);
  assert.equal(request.params.reply_to, "historical-thread-guid");
});

test("rewrites owner sends that use auto service or send.rich onto the owner handle", () => {
  const durable = validateRoutePolicy({
    schemaVersion: 1,
    enabled: true,
    ownerHandles: [owner],
    allowedGroupChatIds: [24],
    notBeforeMs: activation,
    ownerDirectChatId: 570,
  });
  const autoSend = rewriteOwnerSelfChatSend(
    ownerSend({ service: "auto" }),
    durable,
    createOwnerSelfChatRouteCache({ ttlMs: 60_000 }),
  );
  assert.equal(autoSend.params.to, owner);
  assert.equal(Object.hasOwn(autoSend.params, "chat_id"), false);
  const rich = rewriteOwnerSelfChatSend(
    ownerSend({ service: "iMessage" }, "send.rich"),
    durable,
    createOwnerSelfChatRouteCache({ ttlMs: 60_000 }),
  );
  assert.equal(rich.method, "send");
  assert.equal(rich.params.to, owner);
  assert.equal(Object.hasOwn(rich.params, "chat_id"), false);
  assert.equal(Object.hasOwn(rich.params, "reply_to"), false);
});

test("rewrites owner chat_id sends onto the owner handle instead of AppleScript chat_id", () => {
  const durable = validateRoutePolicy({
    schemaVersion: 1,
    enabled: true,
    ownerHandles: [owner],
    allowedGroupChatIds: [24],
    notBeforeMs: activation,
    ownerDirectChatId: 570,
  });
  const rewritten = rewriteOwnerSelfChatSend(
    {
      jsonrpc: "2.0",
      id: 202,
      method: "send",
      params: { chat_id: 570, text: "Rico check", service: "imessage", transport: "auto" },
    },
    durable,
    createOwnerSelfChatRouteCache({ ttlMs: 60_000 }),
  );
  assert.equal(rewritten.params.to, owner);
  assert.equal(Object.hasOwn(rewritten.params, "chat_id"), false);
  assert.equal(rewritten.params.transport, "auto");
  assert.equal(Object.hasOwn(rewritten.params, "reply_to"), false);
});

test("does not retarget owner-handle sends onto the hanging self-chat id", () => {
  const durable = validateRoutePolicy({
    schemaVersion: 1,
    enabled: true,
    ownerHandles: [owner],
    allowedGroupChatIds: [24],
    notBeforeMs: activation,
    ownerDirectChatId: 570,
  });
  const rewritten = rewriteOwnerSelfChatSend(ownerSend(), durable, createOwnerSelfChatRouteCache({ ttlMs: 60_000 }));
  assert.equal(rewritten.params.to, owner);
  assert.equal(Object.hasOwn(rewritten.params, "chat_id"), false);
  assert.equal(Object.hasOwn(rewritten.params, "reply_to"), false);
});

test("the request line relay rewrites only the exact self-chat send", () => {
  const now = activation + 2_000;
  const routes = createOwnerSelfChatRouteCache({ ttlMs: 60_000 });
  assert.equal(observeOwnerSelfChat(ownerSelfChatMessage(), policy, routes, now), true);
  const methods = new Map();
  const request = ownerSend();
  const input = `  ${JSON.stringify(request)}  `;
  const output = transformRequestLine(input, methods, policy, routes, now + 1);
  const parsed = JSON.parse(output);

  assert.equal(parsed.params.to, owner);
  assert.equal(Object.hasOwn(parsed.params, "chat_id"), false);
  assert.equal(Object.hasOwn(parsed.params, "reply_to"), false);
  assert.equal(methods.get(String(request.id)), "send");
});

test("never learns a self-chat route from group, nonowner, mismatched, or stale evidence", () => {
  const now = activation + 2_000;
  const cases = [
    ownerSelfChatMessage({ is_group: true }),
    ownerSelfChatMessage({ is_group: undefined }),
    ownerSelfChatMessage({ chat_id: 0 }),
    ownerSelfChatMessage({ sender: "+15555550101" }),
    ownerSelfChatMessage({ destination_caller_id: "+15555550101" }),
    ownerSelfChatMessage({ created_at: "2026-08-15T11:59:59Z" }),
    ownerSelfChatMessage({ created_at: undefined }),
  ];

  for (const message of cases) {
    const routes = createOwnerSelfChatRouteCache({ ttlMs: 60_000 });
    assert.equal(observeOwnerSelfChat(message, policy, routes, now), false);
    assert.equal(routes.size, 0);
    const request = ownerSend();
    const rewritten = rewriteOwnerSelfChatSend(request, policy, routes, now + 1);
    assert.equal(rewritten.params.to, owner);
    assert.equal(Object.hasOwn(rewritten.params, "chat_id"), false);
    assert.equal(Object.hasOwn(rewritten.params, "reply_to"), false);
    assert.equal(request.params.reply_to, "historical-thread-guid");
  }
});

test("does not seed the live self-chat route from messages.history", () => {
  const now = activation + 2_000;
  const routes = createOwnerSelfChatRouteCache({ ttlMs: 60_000 });
  const methods = new Map();
  trackRpcRequest({ jsonrpc: "2.0", id: 301, method: "messages.history", params: {} }, methods);
  const response = {
    jsonrpc: "2.0",
    id: 301,
    result: { messages: [ownerSelfChatMessage()] },
  };
  transformRpcFrame(response, methods, policy, routes, now);
  assert.equal(routes.size, 0);
  const rewritten = rewriteOwnerSelfChatSend(ownerSend(), policy, routes, now + 1);
  assert.equal(rewritten.params.to, owner);
  assert.equal(Object.hasOwn(rewritten.params, "chat_id"), false);
  assert.equal(Object.hasOwn(rewritten.params, "reply_to"), false);
});

test("fails closed when policy is null or paused and invalidates prior evidence", () => {
  const now = activation + 2_000;
  const paused = {
    schemaVersion: 1,
    enabled: false,
    ownerHandles: [owner],
    allowedGroupChatIds: [24],
    notBeforeMs: activation,
  };
  for (const unavailablePolicy of [null, paused]) {
    const routes = createOwnerSelfChatRouteCache({ ttlMs: 60_000 });
    assert.equal(observeOwnerSelfChat(ownerSelfChatMessage(), policy, routes, now), true);
    const request = ownerSend();
    const untouched = rewriteOwnerSelfChatSend(request, unavailablePolicy, routes, now + 1);
    assert.equal(untouched, request);
    assert.equal(untouched.params.reply_to, "historical-thread-guid");
    assert.equal(routes.size, 0);
    const afterUnavailable = rewriteOwnerSelfChatSend(request, policy, routes, now + 2);
    assert.equal(afterUnavailable.params.to, owner);
    assert.equal(Object.hasOwn(afterUnavailable.params, "chat_id"), false);
    assert.equal(Object.hasOwn(afterUnavailable.params, "reply_to"), false);
  }
});

test("expires the process-local self-chat route and rejects a newer policy fence", () => {
  const now = activation + 2_000;
  const routes = createOwnerSelfChatRouteCache({ ttlMs: 100 });
  assert.equal(observeOwnerSelfChat(ownerSelfChatMessage(), policy, routes, now), true);
  const request = ownerSend();
  const expired = rewriteOwnerSelfChatSend(request, policy, routes, now + 101);
  assert.equal(expired.params.to, owner);
  assert.equal(Object.hasOwn(expired.params, "chat_id"), false);
  assert.equal(Object.hasOwn(expired.params, "reply_to"), false);
  assert.equal(request.params.reply_to, "historical-thread-guid");
  assert.equal(routes.size, 0);

  assert.equal(observeOwnerSelfChat(ownerSelfChatMessage(), policy, routes, now), true);
  const refencedPolicy = validateRoutePolicy({
    schemaVersion: 1,
    enabled: true,
    ownerHandles: [owner],
    allowedGroupChatIds: [24],
    notBeforeMs: activation + 1_500,
  });
  const fenced = rewriteOwnerSelfChatSend(request, refencedPolicy, routes, now + 1);
  assert.equal(fenced.params.to, owner);
  assert.equal(Object.hasOwn(fenced.params, "chat_id"), false);
  assert.equal(Object.hasOwn(fenced.params, "reply_to"), false);
  assert.equal(routes.size, 0);
});

test("preserves ordinary direct, group, nonowner, arbitrary-method, and SMS sends", () => {
  const now = activation + 2_000;
  const freshRoutes = () => {
    const routes = createOwnerSelfChatRouteCache({ ttlMs: 60_000 });
    assert.equal(observeOwnerSelfChat(ownerSelfChatMessage(), policy, routes, now), true);
    return routes;
  };
  const cases = [
    ownerSend({ to: "+15555550101" }),
    ownerSend({ to: "someone@example.com" }),
    ownerSend({ chat_id: 24, to: undefined }),
    ownerSend({ chat_guid: "iMessage;+;group-guid" }),
    ownerSend({ chat_identifier: "iMessage;+;group-identifier" }),
    ownerSend({}, "typing"),
    ownerSend({ service: "sms" }),
  ];

  for (const request of cases) {
    const untouched = rewriteOwnerSelfChatSend(request, policy, freshRoutes(), now + 1);
    assert.equal(untouched, request);
    assert.equal(untouched.params.reply_to, "historical-thread-guid");
  }
});

test("keeps the self-chat cache bounded to the sole most recently observed owner", () => {
  const now = activation + 2_000;
  const routes = createOwnerSelfChatRouteCache({ ttlMs: 60_000 });
  assert.equal(observeOwnerSelfChat(ownerSelfChatMessage({ chat_id: 77 }), policy, routes, now), true);
  assert.equal(observeOwnerSelfChat(ownerSelfChatMessage({ chat_id: 78 }), policy, routes, now + 1), true);
  assert.equal(routes.size, 1);
  const rewritten = rewriteOwnerSelfChatSend(ownerSend(), policy, routes, now + 2);
  assert.equal(rewritten.params.to, owner);
  assert.equal(Object.hasOwn(rewritten.params, "chat_id"), false);
  assert.equal(Object.hasOwn(rewritten.params, "reply_to"), false);
});

test("builds CLI send args for owner handles and group chat ids", () => {
  assert.deepEqual(
    buildImsgCliSendArgs({ to: owner, text: "Rico check", service: "imessage" }),
    ["send", "--json", "--text", "Rico check", "--to", owner, "--service", "imessage"],
  );
  assert.deepEqual(
    buildImsgCliSendArgs({ chat_id: 24, text: "group ping", service: "auto" }),
    ["send", "--json", "--text", "group ping", "--chat-id", "24"],
  );
  assert.throws(() => buildImsgCliSendArgs({ text: "missing target" }), /target/);
});

test("CLI send receipts expose messageId for Gateway health", () => {
  assert.deepEqual(
    rpcResultFromImsgCliSend({ status: "sent", message_id: "ABCD-1234" }),
    {
      ok: true,
      status: "sent",
      transport: "applescript",
      messageId: "ABCD-1234",
      message_id: "ABCD-1234",
      guid: "ABCD-1234",
    },
  );
  assert.equal(rpcResultFromImsgCliSend({ status: "sent" }).ok, true);
  assert.equal(Object.hasOwn(rpcResultFromImsgCliSend({ status: "sent" }), "messageId"), false);
});

test("preserves unknown, non-JSON, and unchanged JSON lines exactly", () => {
  const now = activation + 2_000;
  const routes = createOwnerSelfChatRouteCache({ ttlMs: 60_000 });
  assert.equal(observeOwnerSelfChat(ownerSelfChatMessage(), policy, routes, now), true);
  const methods = new Map();
  const diagnostic = " future protocol: {not-json}\t\r";
  const arbitraryJson = `  ${JSON.stringify(ownerSend({}, "future.method"))}\t\r`;
  const smsJson = `\t${JSON.stringify(ownerSend({ service: "sms" }))}  \r`;

  assert.equal(transformRequestLine(diagnostic, methods, policy, routes, now + 1), diagnostic);
  assert.equal(transformRequestLine(arbitraryJson, methods, policy, routes, now + 1), arbitraryJson);
  assert.equal(transformRequestLine(smsJson, methods, policy, routes, now + 1), smsJson);
  assert.equal(transformResponseLine(diagnostic, methods, policy, routes, now + 1), diagnostic);
  assert.equal(transformResponseLine(arbitraryJson, methods, policy, routes, now + 1), arbitraryJson);
});

test("rejects malformed or overbroad policies", () => {
  assert.equal(validateRoutePolicy(null), null);
  assert.equal(validateRoutePolicy({ schemaVersion: 1, enabled: false, ownerHandles: [owner], allowedGroupChatIds: [24] }), null);
  assert.equal(validateRoutePolicy({ schemaVersion: 1, enabled: true, ownerHandles: [""], allowedGroupChatIds: [24] }), null);
  assert.equal(validateRoutePolicy({ schemaVersion: 1, enabled: true, ownerHandles: [owner], allowedGroupChatIds: [0] }), null);
  assert.equal(validateRoutePolicy({ schemaVersion: 1, enabled: true, ownerHandles: [owner, "+15555550101"], allowedGroupChatIds: [24], notBeforeMs: activation }), null);
  assert.equal(validateRoutePolicy({ schemaVersion: 1, enabled: true, ownerHandles: [owner], allowedGroupChatIds: [24], notBeforeMs: 0 }), null);
  assert.deepEqual(policy.allowedGroupChatIds, [24]);
});

test("the long-lived route observes approval and pause changes without restart", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rico-owner-route-"));
  fs.chmodSync(root, 0o700);
  const file = path.join(root, "rico-owner-command-route.json");
  const write = (value) => {
    fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  };
  const provider = createRoutePolicyProvider(file);
  write({ schemaVersion: 1, enabled: true, ownerHandles: [owner], allowedGroupChatIds: [24], notBeforeMs: activation });
  assert.equal(promoteOwnerCommand(ownerMessage(), provider()).is_from_me, false);

  write({ schemaVersion: 1, enabled: false, ownerHandles: [owner], allowedGroupChatIds: [24], notBeforeMs: activation });
  assert.equal(promoteOwnerCommand(ownerMessage(), provider()).is_from_me, true);

  write({ schemaVersion: 1, enabled: true, ownerHandles: [owner], allowedGroupChatIds: [25], notBeforeMs: activation });
  assert.equal(promoteOwnerCommand(ownerMessage(), provider()).is_from_me, true);
  fs.rmSync(root, { recursive: true, force: true });
});
