import assert from "node:assert/strict";
import test from "node:test";
import {
  isVipDirectTurn,
  RICO_VIP_MODEL,
  selectedModelIsLocalQwen,
  senderHandleFromContext,
  vipHandlesFromPolicy,
  vipModelOverride,
} from "./route.js";
import { isVipDirectIdentity } from "../OpenClawPlugin/policy.js";

const jeff = {
  target: "+18148814454",
  kind: "individual",
  access: "approved",
  requireMention: true,
  autoReply: true,
  quietStart: 22,
  quietEnd: 8,
  vip: true,
};

const janet = {
  target: "+15550000002",
  kind: "individual",
  access: "approved",
  requireMention: true,
  autoReply: true,
  quietStart: 0,
  quietEnd: 0,
};

test("VIP handles come from approved/trusted identities; no vip flag required", () => {
  const policy = { schemaVersion: 2, paused: false, identities: [jeff, janet] };
  assert.deepEqual(vipHandlesFromPolicy(policy, []), ["+18148814454", "+15550000002"]);
  assert.equal(isVipDirectIdentity(jeff), true);
  assert.equal(isVipDirectIdentity({ ...jeff, vip: undefined }), true);
  assert.equal(isVipDirectIdentity(janet), true);
  assert.equal(isVipDirectIdentity({ ...janet, access: "trusted" }), true);
});

test("only VIP directs request Claude; groups and strangers do not", () => {
  const handles = ["+18148814454"];
  assert.equal(isVipDirectTurn({
    sessionKey: "agent:rico-shared:imessage:direct:+18148814454",
  }, { senderId: "+18148814454", channelId: "imessage" }, handles), true);
  assert.equal(isVipDirectTurn({
    sessionKey: "agent:rico-shared:imessage:default:direct",
  }, { senderId: "+18148814454", channelId: "imessage" }, handles), true);
  assert.equal(isVipDirectTurn({
    sessionKey: "agent:rico-shared:imessage:default:direct",
  }, { channelId: "imessage" }, handles), false, "default:direct alone is not a VIP send");
  assert.equal(isVipDirectTurn({
    sessionKey: "agent:rico-shared:imessage:default:direct",
  }, { senderId: "+15550000099", channelId: "imessage" }, handles), false);
  assert.equal(isVipDirectTurn({
    sessionKey: "agent:rico-shared:imessage:group:24",
  }, { senderId: "+18148814454", channelId: "imessage" }, handles), false);
  assert.equal(isVipDirectTurn({
    sessionKey: "agent:rico-shared:imessage:direct:+15550000099",
  }, { senderId: "+15550000099", channelId: "imessage" }, handles), false);
  assert.equal(senderHandleFromContext({}, { sessionKey: "agent:rico-vip:imessage:direct:+18148814454" }), "+18148814454");
});

test("Qwen selections are detected and the override is Claude with no local fallback", () => {
  assert.equal(selectedModelIsLocalQwen({ model: "lmstudio/qwen/qwen3.6-35b-a3b" }), true);
  assert.equal(selectedModelIsLocalQwen({ model: RICO_VIP_MODEL }), false);
  const override = vipModelOverride();
  assert.equal(override.model, RICO_VIP_MODEL);
  assert.equal(override.modelOverride, RICO_VIP_MODEL);
  assert.doesNotMatch(JSON.stringify(override), /qwen|lmstudio/i);
});
