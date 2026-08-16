import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { ISTSIncidentService } from "./service.mjs";

export default definePluginEntry({
  id: "rico-ists-incident",
  name: "Rico ISTS Incident Monitor",
  register(api) {
    const service = new ISTSIncidentService({ api });
    api.registerService({
      id: "rico-ists-incident",
      start: () => service.start(),
      stop: () => service.stop(),
    });
    api.registerGatewayMethod("rico.ists-incident.status", ({ respond }) => {
      respond(true, service.status());
    }, { scope: "operator.read" });
  },
});
