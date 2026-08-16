import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { OutlookMailMonitorService } from "./service.mjs";

export default definePluginEntry({
  id: "rico-outlook-mail-monitor",
  name: "Rico Outlook Mail Monitor",
  register(api) {
    const service = new OutlookMailMonitorService({ api });
    api.registerService({
      id: "rico-outlook-mail-monitor",
      start: () => service.start(),
      stop: () => service.stop(),
    });
    api.registerGatewayMethod("rico.outlook-mail-monitor.status", ({ respond }) => {
      respond(true, service.status());
    }, { scope: "operator.read" });
  },
});
