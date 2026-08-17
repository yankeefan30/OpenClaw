import assert from "node:assert/strict";
import test from "node:test";
import { FORBIDDEN_TOOLS } from "../constants.mjs";
import { callBridgeTool, isForbiddenTool, TOOL_CATALOG } from "../tools.mjs";
import { authHeaders, mockLocalApps, testRuntime, withServer } from "./helpers.mjs";

test("catalog is mail/calendar only and excludes iMessage and chat", () => {
  const names = TOOL_CATALOG.map((item) => item.name);
  assert.deepEqual(names, [
    "health",
    "outlook_list_inbox",
    "outlook_search",
    "outlook_get",
    "outlook_draft",
    "calendar_list",
    "calendar_upsert",
  ]);
  for (const name of FORBIDDEN_TOOLS) {
    assert.equal(isForbiddenTool(name), true);
    assert.equal(names.includes(name), false);
  }
});

test("approved Outlook read and Calendar write stay on local clients", async () => {
  const runtime = testRuntime();
  await withServer(runtime, async (base) => {
    const listed = await fetch(base, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ workflowId: "lindy-cvs-mail-read", tool: "outlook_list_inbox", arguments: { limit: 5 } }),
    });
    assert.equal(listed.status, 200);
    const listedBody = await listed.json();
    assert.equal(listedBody.ok, true);
    assert.equal(listedBody.tool, "outlook_list_inbox");
    assert.equal(listedBody.result.client, "outlook");
    assert.equal(listedBody.result.messages[0].subject, "Flight note");

    const search = await fetch(base, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ workflowId: "lindy-cvs-mail-read", tool: "outlook_search", arguments: { query: "flight" } }),
    });
    assert.equal((await search.json()).result.messages.length, 1);

    const calendar = await fetch(base, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        workflowId: "lindy-cvs-calendar",
        tool: "calendar_upsert",
        arguments: {
          calendar: "CVS",
          title: "Follow-up",
          start: "2026-08-18T10:00:00",
          end: "2026-08-18T10:30:00",
        },
      }),
    });
    const created = await calendar.json();
    assert.equal(calendar.status, 200);
    assert.equal(created.result.client, "calendar");
    assert.equal(created.result.created, true);
  });
});

test("outlook draft is allowlisted and strangers fail closed", async () => {
  const drafts = [];
  const sends = [];
  const runtime = testRuntime(mockLocalApps({ drafts, sends }));
  await withServer(runtime, async (base) => {
    const stranger = await fetch(base, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        workflowId: "lindy-cvs-mail-draft",
        tool: "outlook_draft",
        arguments: { to: "stranger@example.com", subject: "Hi", text: "No." },
      }),
    });
    assert.equal(stranger.status, 400);
    assert.equal((await stranger.json()).error, "recipient_not_allowlisted");
    assert.equal(drafts.length, 0);

    const approved = await fetch(base, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        workflowId: "lindy-cvs-mail-draft",
        tool: "outlook_draft",
        arguments: { to: "janet@example.com", subject: "Follow-up", text: "Draft only." },
      }),
    });
    const body = await approved.json();
    assert.equal(approved.status, 200);
    assert.equal(body.result.drafted, true);
    assert.equal(body.result.sent, false);
    assert.equal(drafts[0].to, "janet@example.com");
    assert.equal(drafts[0].from, "alan.a.rosa@gmail.com");
    assert.equal(sends.length, 0);
  });
});

test("no general ask-Rico endpoint and no iMessage send path", async () => {
  const runtime = testRuntime();
  await withServer(runtime, async (base) => {
    const chat = await fetch(base, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "What should I text Al?", messages: ["hi"] }),
    });
    assert.equal(chat.status, 403);
    assert.equal((await chat.json()).error, "tool_not_allowed");

    for (const tool of ["rico_imessage_send", "ask", "chat", "rico_outlook_send", "rico_mail_send"]) {
      const denied = await fetch(base, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ workflowId: "lindy-cvs-mail-read", tool }),
      });
      assert.equal(denied.status, 403);
      assert.equal((await denied.json()).error, "tool_not_allowed");
    }
  });

  await assert.rejects(
    () => callBridgeTool(runtime, "rico_imessage_send", { to: "+15550000111", text: "nope" }),
    { code: "tool_not_allowed" },
  );
});

test("GET catalog requires auth and reports iMessage disabled", async () => {
  await withServer(testRuntime(), async (base) => {
    const missing = await fetch(base);
    assert.equal(missing.status, 401);
    const catalog = await fetch(base, { headers: authHeaders() });
    const body = await catalog.json();
    assert.equal(catalog.status, 200);
    assert.equal(body.imessage, "disabled");
    assert.equal(body.speaker, "lindy");
    assert.equal(body.tools.some((item) => String(item.name).includes("imessage")), false);
  });
});
