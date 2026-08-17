import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { isVipDirectAudience, resolveVipDirectModel } from "./vip-route.js";

function senderContextFromEvent(event, ctx) {
  const sessionKey = String(event?.sessionKey ?? ctx?.sessionKey ?? "");
  const direct = /:imessage:direct:/i.test(sessionKey);
  const access = String(event?.senderAccess ?? ctx?.senderAccess ?? event?.access ?? "").toLowerCase();
  return {
    conversationType: event?.isGroup === true || sessionKey.includes(":imessage:group:")
      ? "group"
      : direct || event?.isGroup === false
        ? "direct"
        : event?.conversationType,
    isOwner: event?.isOwner === true || access === "owner",
    access: access || (event?.isOwner === true ? "owner" : "approved"),
  };
}

function modelOverride(event, ctx) {
  const context = senderContextFromEvent(event, ctx);
  if (!isVipDirectAudience(context) && context.conversationType !== "direct") return undefined;
  return resolveVipDirectModel({
    conversationType: "direct",
    isOwner: context.isOwner,
    access: context.access || "approved",
  }, event?.sessionKey ?? ctx?.sessionKey);
}

export default definePluginEntry({
  id: "rico-vip-route",
  name: "Rico VIP Route",
  register(api) {
    const apply = (event, ctx) => {
      const model = modelOverride(event, ctx);
      if (!model) return;
      api.logger.info?.(`Rico VIP route selected ${model} for a private direct.`);
      return { model, modelOverride: model };
    };
    api.on("before_agent_run", apply, { priority: 900 });
  },
});
