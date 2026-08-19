import assert from "node:assert/strict";
import test from "node:test";
import {
  callTool,
  createOrUpdateDraft,
  isPublishLike,
  publishOrSchedule,
  resolveOfficialTool,
  scoreTool,
} from "../tools.mjs";

const OFFICIAL = [
  { name: "list_library_items", description: "List drafts in the content library" },
  { name: "get_content", description: "Get one draft or article by id" },
  { name: "create_content", description: "Create or update a draft article or post" },
  { name: "list_connected_channels", description: "List connected publish channels including LinkedIn" },
  { name: "publish_content", description: "Publish or schedule a draft to a connected channel" },
  { name: "twin_chat", description: "Chat with the Content Twin and generate a draft from a brief" },
];

function runtime(overrides = {}) {
  const calls = [];
  return {
    hostIdentity: { hostname: "Rico.local", localHostName: "Rico" },
    authStatus: { available: true, source: "keychain" },
    upstream: {
      async initialize() {
        return { serverInfo: { name: "pressmaster", version: "1" }, instructions: "official" };
      },
      async listOfficialTools() { return OFFICIAL; },
      async callOfficialTool(name, args) {
        calls.push({ name, args });
        return { id: "draft-1", title: "ok" };
      },
    },
    calls,
    ...overrides,
  };
}

test("heuristics map Polar tools onto official names and keep publish separate", () => {
  assert.equal(resolveOfficialTool(OFFICIAL, "list_drafts").name, "list_library_items");
  assert.equal(resolveOfficialTool(OFFICIAL, "get_draft").name, "get_content");
  assert.equal(resolveOfficialTool(OFFICIAL, "create_or_update_draft").name, "create_content");
  assert.equal(resolveOfficialTool(OFFICIAL, "list_channels").name, "list_connected_channels");
  assert.equal(resolveOfficialTool(OFFICIAL, "publish_or_schedule").name, "publish_content");
  assert.equal(resolveOfficialTool(OFFICIAL, "twin_generate").name, "twin_chat");
  assert.equal(isPublishLike("create a draft article"), false);
  assert.equal(isPublishLike("list connected publish channels including linkedin"), false);
  assert.equal(isPublishLike("publish_content publish or schedule a draft"), true);
  assert.equal(scoreTool({ name: "create_content", description: "Create a draft" }, "publish_or_schedule"), 0);
});

test("create/update draft never forwards publish fields or a publish tool", async () => {
  const rt = runtime();
  const created = await createOrUpdateDraft(rt, { title: "Hello", body: "World", format: "article" });
  assert.equal(created.officialTool, "create_content");
  assert.deepEqual(rt.calls, [{ name: "create_content", args: { title: "Hello", body: "World", format: "article" } }]);
  await assert.rejects(
    () => createOrUpdateDraft(rt, { title: "Hello", publish: true }),
    { code: "publish_not_implied" },
  );
  await assert.rejects(
    () => createOrUpdateDraft({
      ...rt,
      upstream: {
        ...rt.upstream,
        async listOfficialTools() {
          return [{ name: "publish_now", description: "Publish a draft live" }];
        },
      },
    }, { title: "Hello" }),
    { code: "official_tool_missing" },
  );
});

test("publish tool exists and dry-run never hits Pressmaster", async () => {
  const rt = runtime();
  const dry = await publishOrSchedule(rt, { draftId: "draft-1", channel: "linkedin", dryRun: true });
  assert.deepEqual(dry, {
    ok: true,
    dryRun: true,
    forwarded: false,
    officialTool: "publish_content",
    wouldCall: { name: "publish_content", arguments: { draftId: "draft-1", channel: "linkedin" } },
    note: "No Pressmaster or LinkedIn publish was sent.",
  });
  assert.deepEqual(rt.calls, []);
});

test("missing auth fails closed with a precise login error", async () => {
  await assert.rejects(
    () => callTool({ authStatus: { available: false, source: "none" } }, "rico_pressmaster_list_drafts", {}),
    (error) => {
      assert.equal(error.code, "pressmaster_auth_missing");
      assert.match(error.message, /--login/);
      assert.match(error.message, /redirect_uri/);
      return true;
    },
  );
});

test("health never claims a live publish ran", async () => {
  const result = await callTool(runtime({ probeOfficial: false }), "rico_pressmaster_health", {});
  assert.equal(result.ok, true);
  assert.equal(result.livePublish, false);
  assert.equal(result.auth.available, true);
  assert.match(result.linkedin.note, /LinkedIn posts/);
});
