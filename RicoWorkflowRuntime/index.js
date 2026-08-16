import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { compileNaturalLanguage, validatePlan, TIME_ZONE } from "./compiler.js";
import { WorkflowStore, newWorkflowId } from "./store.js";
import { installCron, removeCron } from "./cron.js";

const PLUGIN_ID = "rico-workflow";
const POLICY_PATH = path.join(os.homedir(), "Library", "Application Support", "OpenClaw Studio", "rico-recipient-guard.json");
const TOOLS = [
  "rico_schedule_text",
  "rico_workflow_compile",
  "rico_workflow_install",
  "rico_workflow_list",
  "rico_workflow_cancel",
];

const grants = new Map();

function readPolicy() {
  const parsed = JSON.parse(fs.readFileSync(POLICY_PATH, "utf8"));
  if (parsed?.schemaVersion !== 2 || !Array.isArray(parsed.identities)) {
    throw new Error("Rico recipient policy is unavailable.");
  }
  return parsed;
}

function ownerHandle(policy) {
  const owners = policy.identities.filter((item) => item?.access === "owner" && item.kind === "individual");
  if (owners.length !== 1) throw new Error("Rico owner identity is unavailable.");
  return String(owners[0].target ?? "");
}

function senderIsOwner(ctx, policy) {
  const sessionKey = String(ctx.sessionKey ?? "").toLowerCase();
  const owner = ownerHandle(policy);
  const sender = String(ctx.senderId ?? "").trim();
  if (sender && sender.replace(/\D/g, "") === owner.replace(/\D/g, "")) return true;
  return sessionKey.includes(`:imessage:direct:${owner.toLowerCase()}`);
}

function grantKey(runId, toolCallId) {
  return `${runId}\0${toolCallId}`;
}

function textResult(text, details) {
  return { content: [{ type: "text", text }], details };
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Rico Workflow Compiler",
  register(api) {
    const store = new WorkflowStore();

    api.on("before_prompt_build", async (_event, ctx) => {
      try {
        const policy = readPolicy();
        if (!senderIsOwner(ctx, policy)) return;
        return {
          prependContext: [
            "Rico can compile and install owner-described iMessage workflows without asking Alan to write code.",
            "When Alan describes a reminder, recurring text, or simple personal workflow, call rico_workflow_compile then rico_workflow_install, or rico_schedule_text for a one-line reminder.",
            "Only send scheduled iMessages to reviewed allowlisted people. Never invent new recipients, never disable SIP, and never dump tokens.",
            "After a successful install, confirm the schedule in one short sentence. Do not ask Alan to open Studio or edit files.",
          ].join(" "),
        };
      } catch {
        return;
      }
    }, { priority: 40, timeoutMs: 2_000 });

    api.on("before_tool_call", async (event, ctx) => {
      if (!TOOLS.includes(event.toolName)) return;
      try {
        const policy = readPolicy();
        if (policy.paused === true) {
          return { block: true, blockReason: "Rico communications are paused, so workflows cannot change." };
        }
        if (!senderIsOwner(ctx, policy)) {
          return { block: true, blockReason: "Only Alan can install or change Rico workflows." };
        }
        const runId = String(event.runId ?? ctx.runId ?? "").trim();
        const toolCallId = String(event.toolCallId ?? ctx.toolCallId ?? "").trim();
        if (!runId || !toolCallId) {
          return { block: true, blockReason: "Workflow tools require a live owner run." };
        }
        grants.set(grantKey(runId, toolCallId), { ownerHandle: ownerHandle(policy), identities: policy.identities, createdAt: Date.now() });
      } catch {
        return { block: true, blockReason: "Rico workflow authority is unavailable." };
      }
    }, { priority: 40, timeoutMs: 3_000 });

    const execute = async (name, toolCallId, params) => {
      const matches = [...grants.entries()].filter(([, grant]) => grant && Date.now() - grant.createdAt < 120_000);
      const found = matches.find(([key]) => key.endsWith(`\0${toolCallId}`));
      if (!found) throw new Error("Owner workflow grant is unavailable.");
      grants.delete(found[0]);
      const { ownerHandle: owner, identities } = found[1];
      if (name === "rico_workflow_list") {
        const workflows = store.list().map((item) => ({
          id: item.id,
          name: item.name,
          recipientName: item.recipientName,
          schedule: item.schedule,
          kind: item.kind,
        }));
        return textResult(workflows.length === 0 ? "No Rico workflows are installed." : JSON.stringify(workflows, null, 2), { workflows });
      }
      if (name === "rico_workflow_compile") {
        const compiled = compileNaturalLanguage({ text: params.description, ownerHandle: owner, identities });
        if (!compiled.ok) return textResult(compiled.error, compiled);
        return textResult(`Ready to install: ${compiled.plan.recipientName} / ${compiled.plan.payload.text ?? compiled.plan.payload.prompt}`, compiled);
      }
      if (name === "rico_workflow_cancel") {
        const id = String(params.id ?? "").trim();
        const current = store.list().find((item) => item.id === id);
        if (!current) throw new Error("That workflow is not installed.");
        if (current.cronId) {
          try { await removeCron(current.cronId); } catch { /* still drop the local record */ }
        }
        store.remove(id);
        return textResult(`Cancelled ${current.name}.`, { id });
      }

      let compiled;
      if (name === "rico_schedule_text") {
        compiled = compileNaturalLanguage({
          text: `text ${params.to || "me"} ${JSON.stringify(params.text ?? "")} ${params.when ?? ""}`.trim(),
          ownerHandle: owner,
          identities,
        });
      } else if (params.plan) {
        compiled = validatePlan(params.plan, { ownerHandle: owner, identities });
      } else {
        compiled = compileNaturalLanguage({ text: params.description, ownerHandle: owner, identities });
      }
      if (!compiled.ok) return textResult(compiled.error, compiled);
      const validated = validatePlan(compiled.plan, { ownerHandle: owner, identities });
      if (!validated.ok) return textResult(validated.error, validated);
      const installed = await installCron(validated.plan);
      const record = {
        id: newWorkflowId(),
        cronId: installed.cronId,
        createdAt: new Date().toISOString(),
        timeZone: TIME_ZONE,
        ...validated.plan,
      };
      store.save(record);
      const when = record.schedule.type === "at" ? record.schedule.at : `${record.schedule.expr} ${record.schedule.tz}`;
      return textResult(`Installed. Rico will text ${record.recipientName} at ${when}.`, { id: record.id, cronId: record.cronId, plan: validated.plan });
    };

    const tool = (name, description, parameters) => {
      api.registerTool({
        name,
        label: name,
        description,
        parameters,
        executionMode: "sequential",
        async execute(toolCallId, params) {
          return execute(name, toolCallId, params ?? {});
        },
      }, { name });
    };

    tool("rico_schedule_text", "Schedule one exact iMessage for Alan or an approved contact. Use for reminders and recurring texts.", {
      type: "object",
      additionalProperties: false,
      required: ["text", "when"],
      properties: {
        to: { type: "string", description: "me, a reviewed display name, or an allowlisted E.164 number" },
        text: { type: "string", minLength: 1, maxLength: 1000 },
        when: { type: "string", description: "Natural time such as 'in 20 minutes', 'at 8am', or 'every weekday at 8am'" },
      },
    });
    tool("rico_workflow_compile", "Compile Alan's natural-language workflow into a Rico plan without installing it yet.", {
      type: "object",
      additionalProperties: false,
      required: ["description"],
      properties: { description: { type: "string", minLength: 3, maxLength: 2000 } },
    });
    tool("rico_workflow_install", "Install a compiled Rico workflow or compile-and-install from Alan's description. No coding required.", {
      type: "object",
      additionalProperties: false,
      properties: {
        description: { type: "string", minLength: 3, maxLength: 2000 },
        plan: { type: "object" },
      },
    });
    tool("rico_workflow_list", "List installed Rico workflows.", {
      type: "object",
      additionalProperties: false,
      properties: {},
    });
    tool("rico_workflow_cancel", "Cancel one installed Rico workflow.", {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string", minLength: 3, maxLength: 80 } },
    });
  },
});
