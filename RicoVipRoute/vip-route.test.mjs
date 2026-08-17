import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  RICO_SHARED_LOCAL_MODEL,
  RICO_VIP_DIRECT_MODEL,
  resolveVipDirectModel,
  vipSessionModelIsClaude,
} from "./vip-route.js";

test("VIP and owner directs resolve to Claude, never Qwen", () => {
  for (const context of [
    { conversationType: "direct", access: "approved", isOwner: false },
    { conversationType: "direct", access: "trusted", isOwner: false },
    { conversationType: "direct", access: "owner", isOwner: true },
  ]) {
    assert.equal(resolveVipDirectModel(context), RICO_VIP_DIRECT_MODEL);
    assert.notEqual(resolveVipDirectModel(context), RICO_SHARED_LOCAL_MODEL);
    assert.equal(vipSessionModelIsClaude(context), true);
  }
});

test("live rico-shared default:direct is a VIP Claude session", () => {
  const jeff = { conversationType: "direct", access: "approved", isOwner: false };
  const liveKey = "agent:rico-shared:imessage:default:direct";
  assert.equal(resolveVipDirectModel(jeff, liveKey), RICO_VIP_DIRECT_MODEL);
  assert.equal(vipSessionModelIsClaude(jeff, liveKey), true);
  assert.notEqual(resolveVipDirectModel(jeff, liveKey), RICO_SHARED_LOCAL_MODEL);
});

test("groups do not steal the VIP Claude route", () => {
  assert.equal(resolveVipDirectModel({
    conversationType: "group",
    access: "approved",
    groupTarget: "chat_id:42",
  }), undefined);
});

test("plugin registers only the model-selection hook", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"));
  const source = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
  assert.deepEqual(manifest.contracts.hooks, ["before_agent_run"]);
  assert.match(source, /id: "rico-vip-route"/u);
  assert.match(source, /modelOverride/u);
  assert.match(source, /:imessage:\(\?:default:\)\?direct/u);
});
