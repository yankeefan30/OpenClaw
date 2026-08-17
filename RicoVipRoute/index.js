import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  isVipDirectTurn,
  loadVipHandles,
  selectedModelIsLocalQwen,
  supportDirectory,
  vipModelOverride,
} from "./route.js";

const directory = supportDirectory();

export default definePluginEntry({
  id: "rico-vip-route",
  name: "Rico VIP Route",
  register(api) {
    function vipOverride(event, ctx, hook) {
      const handles = loadVipHandles({ directory });
      if (!isVipDirectTurn(event, ctx, handles)) return;
      if (selectedModelIsLocalQwen(event, ctx)) {
        api.logger.error?.(`Rico VIP route replaced a local Qwen selection on ${hook} with Claude.`);
      } else {
        api.logger.info?.(`Rico VIP route pinned Claude for an ISTS/VIP direct on ${hook}.`);
      }
      return vipModelOverride();
    }

    api.on("before_prompt_build", async (event, ctx) => vipOverride(event, ctx, "before_prompt_build"), { priority: 900 });
    api.on("before_agent_run", async (event, ctx) => vipOverride(event, ctx, "before_agent_run"), { priority: 900 });
  },
});
