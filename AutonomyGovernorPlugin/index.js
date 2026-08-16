import os from "node:os";
import path from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { AutonomyGovernor, errorEnvelope } from "./governor.js";
import { DurableStateStore } from "./state-store.js";

const PLUGIN_ID = "rico-autonomy-governor";

function configuredConversationAccess(config) {
  return config?.plugins?.entries?.[PLUGIN_ID]?.hooks?.allowConversationAccess === true;
}

function stateDirectory(api) {
  const configured = api.pluginConfig?.stateDirectory;
  if (configured !== undefined) return path.normalize(configured);
  return path.join(os.homedir(), "Library", "Application Support", "OpenClaw Studio", "autonomy-governor");
}

function registerRpc(api, governor, name, scope, handler) {
  api.registerGatewayMethod(name, ({ params, respond }) => {
    try {
      respond(true, handler(params ?? {}));
    } catch (error) {
      api.logger.warn?.(`${name} rejected: ${error instanceof Error ? error.message : String(error)}`);
      respond(false, undefined, errorEnvelope(error));
    }
  }, { scope });
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Rico Autonomy Governor",
  register(api) {
    const store = new DurableStateStore(stateDirectory(api));
    const governor = new AutonomyGovernor(store, {
      conversationAccessConfigured: configuredConversationAccess(api.config),
    });

    registerRpc(api, governor, "rico.autonomy.status", "operator.read", () => governor.status());
    registerRpc(api, governor, "rico.autonomy.missions.list", "operator.read", () => governor.listMissions());
    registerRpc(api, governor, "rico.autonomy.missions.get", "operator.read", (params) => governor.getMission(params.id));
    registerRpc(api, governor, "rico.autonomy.events.list", "operator.read", (params) => governor.events(params));
    registerRpc(api, governor, "rico.autonomy.evaluate", "operator.read", (params) => governor.evaluate(params));

    registerRpc(api, governor, "rico.autonomy.missions.upsert", "operator.admin", (params) => governor.upsert(params));
    registerRpc(api, governor, "rico.autonomy.missions.activate", "operator.admin", (params) => governor.activate(params));
    registerRpc(api, governor, "rico.autonomy.missions.pause", "operator.admin", (params) => governor.pauseMission(params));
    registerRpc(api, governor, "rico.autonomy.missions.resume", "operator.admin", (params) => governor.resumeMission(params));
    registerRpc(api, governor, "rico.autonomy.missions.advance", "operator.admin", (params) => governor.advance(params));
    registerRpc(api, governor, "rico.autonomy.global.pause", "operator.admin", (params) => governor.setGlobalPaused(true, params));
    registerRpc(api, governor, "rico.autonomy.global.resume", "operator.admin", (params) => governor.setGlobalPaused(false, params));

    api.on("before_agent_run", (event, context) => governor.beforeAgentRun(event, context), { priority: 900, timeoutMs: 5_000 });
    api.on("agent_end", (event, context) => governor.agentEnd(event, context), { priority: 900, timeoutMs: 5_000 });
    api.on("before_tool_call", (event, context) => governor.beforeToolCall(event, context), { priority: 900, timeoutMs: 5_000 });
    api.on("after_tool_call", (event, context) => governor.afterToolCall(event, context), { priority: 900, timeoutMs: 5_000 });
    api.on("message_sending", (event, context) => governor.messageSending(event, context), { priority: 900, timeoutMs: 5_000 });
    api.on("message_sent", (event, context) => governor.messageSent(event, context), { priority: 900, timeoutMs: 5_000 });
  },
});
