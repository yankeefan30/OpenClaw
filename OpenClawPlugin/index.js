import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  consumeOwnerAuthorization,
  createSessionAttestationStore,
  createSenderContextRegistry,
  evaluateInbound,
  internalEscalationMetadataReason,
  internalRuntimePayloadDisposition,
  isInternalModelBackendFailure,
  isInternalRuntimeStatusReply,
  istsIncidentPromptSection,
  isOwnerRouteTrigger,
  isInternalModelRoutingNotice,
  normalize,
  outboundIdentity,
  parseIMessageGroups,
  readPolicy,
  RICO_ESCALATION_SAFE_REPLY,
  RICO_GENERIC_RUNTIME_ERROR,
  resolveSenderContext,
  senderSystemContext,
  senderIsolationApplied,
  sharedAudienceSystemPrompt,
  verifyGroupMembership,
} from "./policy.js";
import {
  createPeopleContextRunRegistry,
  readReviewedPeopleContext,
} from "./people-context.js";
import { privateProvenanceDisclosureReason } from "./research-policy.js";
import { createISTSIncidentPromptIntegration } from "./ists-incident-integration.js";
import { automaticIMTSignedClosureHealth, createAutomaticIMTHandoff } from "./automatic-imt-handoff.js";
import { ownerPrivateSkillsSystemContext } from "./skills-context.js";
import {
  createGroupEmailExecutionRegistry,
  RICO_GROUP_EMAIL_TOOL_DESCRIPTION,
  RICO_GROUP_EMAIL_TOOL_NAME,
  RICO_GROUP_EMAIL_TOOL_PARAMETERS,
} from "./group-email-integration.js";
import {
  createSharedEscalationProofRegistry,
  currentPolicyAllowsSharedEscalation,
  escalationCapabilityForContext,
  escalationOriginAuthorityHealthy,
  escalationPluginConfigured,
  RICO_ESCALATION_TOOL_NAME,
} from "./escalation-guard.js";

const bundledGovernance = new URL("./RicoEmailGovernance/index.mjs", import.meta.url);
const sourceGovernance = new URL("../RicoEmailGovernance/index.mjs", import.meta.url);
const governanceURL = fs.existsSync(fileURLToPath(bundledGovernance)) ? bundledGovernance : sourceGovernance;
let governanceModulePromise;
function loadGovernanceModule() {
  governanceModulePromise ??= import(governanceURL.href);
  return governanceModulePromise;
}

const execFileAsync = promisify(execFile);

const directory = path.join(os.homedir(), "Library", "Application Support", "OpenClaw Studio");
const policyPath = path.join(directory, "rico-recipient-guard.json");
const grantsDirectory = path.join(directory, "owner-send-grants");
const sessionAttestationPath = path.join(directory, "rico-sender-session-attestations.json");
const senderContexts = createSenderContextRegistry();
const peopleContexts = createPeopleContextRunRegistry();
const sharedEscalationProofs = createSharedEscalationProofRegistry();
const sessionAttestations = createSessionAttestationStore({
  filePath: sessionAttestationPath,
  supportDirectory: directory,
});
const guardVersion = "0.5.7";
const guardContractVersion = "rico-recipient-guard/v6";
const hookContract = [
  "inbound_claim",
  "before_dispatch",
  "before_prompt_build",
  "before_agent_run",
  "before_tool_call",
  "agent_end",
  "reply_payload_sending",
  "message_sending",
];

function configuredHookPermissions(config) {
  const hooks = config?.plugins?.entries?.["rico-recipient-guard"]?.hooks;
  return {
    allowConversationAccess: hooks?.allowConversationAccess === true,
    allowPromptInjection: hooks?.allowPromptInjection === true,
  };
}

function isIMessageRun(event, ctx) {
  const provider = String(ctx.messageProvider ?? ctx.channel ?? "").toLowerCase();
  const sessionKey = String(ctx.sessionKey ?? "").toLowerCase();
  return provider === "imessage" || sessionKey.includes(":imessage:") || String(event.channelId ?? "").toLowerCase() === "imessage";
}

function inboundEventForAgentRun(event, ctx) {
  const sessionKey = String(ctx.sessionKey ?? "");
  const groupMatch = sessionKey.match(/:imessage:group:([^:]+)(?:$|:)/i);
  const directMatch = sessionKey.match(/:imessage:direct:([^:]+)(?:$|:)/i);
  const senderId = ctx.senderId ?? (directMatch ? directMatch[1] : undefined);
  return {
    channel: "imessage",
    senderId,
    isGroup: Boolean(groupMatch),
    threadId: ctx.chatId ?? groupMatch?.[1],
    sessionKey,
    runId: ctx.runId,
    messageId: ctx.messageId,
    content: event.prompt,
    bodyForAgent: event.prompt,
  };
}

async function readIMessageGroups() {
  // Stay comfortably below OpenClaw's 15s before_prompt_build deadline. If
  // group discovery cannot finish here, the later gate blocks the run.
  const { stdout } = await execFileAsync("/opt/homebrew/bin/imsg", ["chats", "--limit", "200", "--json"], { timeout: 8000 });
  return parseIMessageGroups(stdout);
}

export default definePluginEntry({
  id: "rico-recipient-guard",
  name: "Rico Recipient Guard",
  register(api) {
    const hookPermissions = configuredHookPermissions(api.config);
    const groupEmailExecutions = createGroupEmailExecutionRegistry();
    const istsIncidentPrompts = createISTSIncidentPromptIntegration({ api });
    const automaticIMTHandoff = createAutomaticIMTHandoff();
    let groupEmailRuntime;
    async function loadGroupEmailRuntime() {
      if (groupEmailRuntime) return groupEmailRuntime;
      const {
        DeliveryLedger, GroupEmailBroker, GroupEmailToolExecutor, NativeOutlookAdapter,
        PersonEmailAuthorizationProvider, RecipientGuardGroupAuthorizationProvider,
      } = await loadGovernanceModule();
      const emailAuthorizations = new PersonEmailAuthorizationProvider();
      const groupAuthorizations = new RecipientGuardGroupAuthorizationProvider();
      const outlook = new NativeOutlookAdapter({ sendEnabled: true });
      const broker = new GroupEmailBroker({
        principalAdapter: { verifyInboundPrincipal: (request) => groupEmailExecutions.verifyInboundPrincipal(request) },
        outlookAdapter: outlook,
        ledger: new DeliveryLedger(),
      });
      const tool = new GroupEmailToolExecutor({
        broker,
        authorizationProvider: emailAuthorizations,
        groupAuthorizationProvider: groupAuthorizations,
        verifyRequestOrigin: (runtimeContext) => groupEmailExecutions.consume(runtimeContext),
      });
      groupEmailRuntime = Object.freeze({ emailAuthorizations, groupAuthorizations, outlook, tool });
      return groupEmailRuntime;
    }

    api.registerTool({
      name: RICO_GROUP_EMAIL_TOOL_NAME,
      label: "Rico governed group email",
      description: RICO_GROUP_EMAIL_TOOL_DESCRIPTION,
      parameters: RICO_GROUP_EMAIL_TOOL_PARAMETERS,
      executionMode: "sequential",
      async execute(toolCallId, params) {
        try {
          const { tool } = await loadGroupEmailRuntime();
          const result = await tool.execute({
            runtimeContext: { toolCallId },
            input: params,
          });
          const status = result?.status === "sent" ? "sent" : result?.status === "already-claimed" ? "already handled" : "outcome unknown";
          return { content: [{ type: "text", text: `Governed Outlook email status: ${status}.` }], details: { status: result?.status ?? "outcome-unknown" } };
        } catch (error) {
          const code = /^[a-z0-9_]{1,120}$/u.test(String(error?.code ?? error?.message ?? ""))
            ? String(error.code ?? error.message)
            : "group_email_execution_failed";
          throw new Error(code);
        }
      },
    }, { name: RICO_GROUP_EMAIL_TOOL_NAME });
    api.registerGatewayMethod("rico.imessage.groups", async ({ respond }) => {
      try {
        const groups = await readIMessageGroups();
        respond(true, { groups });
      } catch (error) {
        respond(false, undefined, { code: "UNAVAILABLE", message: `Unable to read iMessage groups: ${error instanceof Error ? error.message : String(error)}` });
      }
    }, { scope: "operator.read" });

    api.registerGatewayMethod("rico.recipient.status", async ({ respond }) => {
      try {
        const policy = readPolicy(policyPath, directory);
        const automaticIMTHealth = await automaticIMTSignedClosureHealth();
        if (automaticIMTHealth?.ok !== true || automaticIMTHealth.closure !== "signed-nested") {
          throw new Error("automatic_imt_signed_module_unavailable");
        }
        respond(true, {
          version: guardVersion,
          contractVersion: guardContractVersion,
          healthy: hookPermissions.allowConversationAccess && hookPermissions.allowPromptInjection,
          paused: policy.paused,
          policySchema: policy.schemaVersion,
          hooks: hookContract,
          tools: [RICO_GROUP_EMAIL_TOOL_NAME],
          escalation: {
            toolName: RICO_ESCALATION_TOOL_NAME,
            pluginConfigured: escalationPluginConfigured(api.config),
            originAuthorityHealthy: escalationOriginAuthorityHealthy(),
          },
          automaticIMT: {
            healthy: true,
            requestContract: "imt-current-status/v1",
            mode: "before_dispatch",
          },
          hookPermissions,
          enforcement: {
            verified: true,
            authority: "gateway",
            contractVersion: guardContractVersion,
          },
        });
      } catch (error) {
        respond(false, undefined, {
          code: "ENFORCEMENT_UNAVAILABLE",
          message: `Rico recipient enforcement is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }, { scope: "operator.read" });

    api.on("inbound_claim", async (event, ctx) => {
      const channel = String(ctx.channelId ?? event.channel ?? "").toLowerCase();
      if (channel !== "imessage") return;
      try {
        const policy = readPolicy(policyPath, directory);
        const decision = evaluateInbound(event, ctx, policy);
        if (decision.allow) {
          const senderContext = resolveSenderContext(event, ctx, policy);
          if (senderContext?.conversationType === "group") {
            const membership = verifyGroupMembership(policy, senderContext.groupTarget, await readIMessageGroups());
            if (!membership.matches) {
              api.logger.warn?.("Rico guard claimed an inbound iMessage because reviewed group membership no longer matches");
              return { handled: true };
            }
          }
          if (!senderContexts.remember(event, ctx, senderContext)) {
            api.logger.error?.("Rico guard claimed inbound iMessage because its sender context could not be bound to this run");
            return { handled: true };
          }
          return;
        }
        api.logger.warn?.(`Rico guard claimed denied inbound iMessage: ${decision.reason}`);
        // Claim without a reply: the message is neither dispatched to Rico nor
        // answered. This is the inbound equivalent of a fail-closed cancel.
        return { handled: true };
      } catch (error) {
        api.logger.error?.(`Rico guard claimed inbound iMessage because policy could not be verified: ${error instanceof Error ? error.message : String(error)}`);
        return { handled: true };
      }
    }, { priority: 1000 });

    // `before_dispatch` is the global ordinary-channel ingress gate in the
    // installed OpenClaw build. Keep inbound_claim for plugin-bound/future
    // paths, but enforce the same fail-closed policy here as well.
    api.on("before_dispatch", async (event, ctx) => {
      const channel = String(event.channel ?? ctx.channelId ?? "").toLowerCase();
      const sessionKey = String(event.sessionKey ?? ctx.sessionKey ?? "").toLowerCase();
      if (channel !== "imessage" && !sessionKey.includes(":imessage:")) return;
      try {
        const policy = readPolicy(policyPath, directory);
        const normalizedEvent = {
          ...event,
          isGroup: event.isGroup === true || sessionKey.includes(":imessage:group:"),
        };
        const decision = evaluateInbound(normalizedEvent, ctx, policy);
        if (!decision.allow) return { handled: true };
        const senderContext = resolveSenderContext(normalizedEvent, ctx, policy);
        let currentGroupMembership = true;
        if (senderContext?.conversationType === "group") {
          const membership = verifyGroupMembership(policy, senderContext.groupTarget, await readIMessageGroups());
          if (!membership.matches) return { handled: true };
          currentGroupMembership = true;
        }
        const automaticReply = await automaticIMTHandoff.responseForInbound({
          recipientGuardAdmitted: true,
          senderContext,
          inbound: normalizedEvent,
          hookContext: ctx,
          currentGroupMembership,
          revalidateAudience: async () => {
            const currentPolicy = readPolicy(policyPath, directory);
            const currentDecision = evaluateInbound(normalizedEvent, ctx, currentPolicy);
            if (!currentDecision.allow) return false;
            const currentContext = resolveSenderContext(normalizedEvent, ctx, currentPolicy);
            if (!currentContext || currentContext.senderHandle !== senderContext.senderHandle ||
                currentContext.conversationType !== senderContext.conversationType ||
                currentContext.isOwner !== senderContext.isOwner || currentContext.access !== senderContext.access ||
                currentContext.audienceFingerprint !== senderContext.audienceFingerprint ||
                currentContext.groupTarget !== senderContext.groupTarget) return false;
            if (currentContext.conversationType === "group") {
              const membership = verifyGroupMembership(
                currentPolicy,
                currentContext.groupTarget,
                await readIMessageGroups(),
              );
              if (!membership.matches) return false;
            }
            return true;
          },
        });
        if (automaticReply?.handled === true) {
          return automaticReply.text
            ? { handled: true, text: automaticReply.text }
            : { handled: true };
        }
        return;
      } catch (error) {
        api.logger.error?.(`Rico guard handled inbound iMessage before dispatch because policy could not be verified: ${error instanceof Error ? error.message : String(error)}`);
        return { handled: true };
      }
    }, { priority: 1000 });

    api.on("before_prompt_build", async (event, ctx) => {
      let senderContext = senderContexts.get(ctx);
      const inbound = isIMessageRun(event, ctx) ? inboundEventForAgentRun(event, ctx) : undefined;
      let admissionDecision;
      // Ordinary iMessage dispatch is not plugin-bound in OpenClaw 2026.7,
      // so global inbound_claim may not run. Resolve again from the agent
      // hook's authenticated sender/chat context and the exact session key.
      if (!senderContext && isIMessageRun(event, ctx)) {
        try {
          const policy = readPolicy(policyPath, directory);
          admissionDecision = evaluateInbound(inbound, ctx, policy);
          if (!admissionDecision.allow) return;
          senderContext = resolveSenderContext(inbound, ctx, policy);
          if (senderContext?.conversationType === "group") {
            const membership = verifyGroupMembership(policy, senderContext.groupTarget, await readIMessageGroups());
            if (!membership.matches) return;
          }
          if (!senderContexts.remember(inbound, ctx, senderContext)) return;
        } catch (error) {
          api.logger.error?.(`Rico sender context could not be resolved before prompt build: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
      }
      if (!senderContext) return;
      // People context is optional and never grants authority. Re-run the
      // existing exact inbound decision before binding it, even when the
      // sender context was populated by an earlier hook.
      try {
        if (!inbound?.senderId) throw new Error("authenticated sender is unavailable");
        const policy = readPolicy(policyPath, directory);
        admissionDecision ??= evaluateInbound(inbound, ctx, policy);
        const projection = readReviewedPeopleContext({ supportDirectory: directory });
        if (projection && inbound?.senderId && peopleContexts.bind({
          runId: ctx.runId,
          authenticatedSender: inbound.senderId,
          admissionDecision,
          projection,
          originalPrompt: event.prompt,
        })) {
          const section = peopleContexts.inject({
            runId: ctx.runId,
            authenticatedSender: inbound.senderId,
            prompt: event.prompt,
          });
          if (section) {
            senderContext = { ...senderContext, reviewedPersonContext: section };
            if (!senderContexts.remember(inbound, ctx, senderContext)) return;
          }
        }
      } catch (error) {
        // An unavailable optional profile suppresses personalization; it does
        // not weaken the existing recipient, prompt, tool, or session gates.
        api.logger.warn?.(`Rico reviewed people context was unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      const isISTSDirectCandidate = senderContext.conversationType === "direct";
      const isISTSGroupCandidate = senderContext.conversationType === "group";
      // This is context admission, not a second channel ingress. The ordinary
      // recipient guard must already have admitted the exact group and its
      // current membership; unreviewed groups never reach this branch.
      if (isISTSDirectCandidate || isISTSGroupCandidate) {
        let currentGroupMembership = true;
        if (isISTSGroupCandidate) {
          try {
            const policy = readPolicy(policyPath, directory);
            currentGroupMembership = verifyGroupMembership(
              policy,
              senderContext.groupTarget,
              await readIMessageGroups(),
            ).matches;
          } catch {
            currentGroupMembership = false;
          }
        }
        if (admissionDecision?.allow === true && currentGroupMembership) {
          const section = await istsIncidentPrompts.contextForTurn({
            senderContext,
            hookContext: ctx,
            messageText: inbound?.bodyForAgent ?? "",
            recipientGuardAdmitted: true,
          });
          if (section) {
            senderContext = { ...senderContext, istsIncidentContext: section };
            if (!senderContexts.remember(inbound, ctx, senderContext)) return;
          }
        }
      }
      const ownerSkillsContext = await ownerPrivateSkillsSystemContext({
        senderContext,
        supportDirectory: directory,
      });
      if (!senderContexts.bindOriginalPrompt(ctx, event.prompt)) return;
      if (senderContext.isOwner === true && senderContext.conversationType === "group") {
        try {
          const { outlook, groupAuthorizations, emailAuthorizations } = await loadGroupEmailRuntime();
          const [health, group, profiles] = await Promise.all([
            outlook.health(),
            groupAuthorizations.get(senderContext.groupTarget),
            emailAuthorizations.listToolOptions(),
          ]);
          if (health.ok === true && health.sendEnabled === true && profiles.length > 0) {
            senderContext = {
              ...senderContext,
              groupEmailCapability: { available: true, groupRevision: group.revision, profiles },
            };
            if (!senderContexts.remember(inbound, ctx, senderContext)) return;
          }
        } catch {
          // Missing Outlook proof or reviewed profiles keeps the tool absent.
        }
      }
      const escalationCapability = escalationCapabilityForContext(senderContext, api.config);
      if (escalationCapability) {
        senderContext = { ...senderContext, escalationCapability };
        if (!senderContexts.remember(inbound, ctx, senderContext)) return;
      }
      if (senderContext.isOwner !== true || senderContext.conversationType === "group") {
        // Replace the entire bootstrap system prompt for every shared
        // audience. Alan's private workspace/memory context is therefore
        // removed before the model sees the turn.
        return { systemPrompt: sharedAudienceSystemPrompt(senderContext) };
      }
      return {
        // Authenticated identity belongs only in the system prompt. Keeping it
        // out of user-role context prevents a sender from imitating Rico's
        // trusted routing block in their own message.
        appendSystemContext: [
          senderSystemContext(senderContext),
          senderContext.reviewedPersonContext,
          istsIncidentPromptSection(senderContext),
          ownerSkillsContext,
        ].filter(Boolean).join("\n\n"),
      };
    }, { priority: 1000 });

    api.on("before_agent_run", async (event, ctx) => {
      if (!isIMessageRun(event, ctx)) return;
      const senderContext = senderContexts.get(ctx);
      // Verify the host-applied prompt itself. A timed-out prompt hook may
      // finish its local side effects after OpenClaw discarded its result; a
      // registry flag alone is therefore never proof that isolation landed.
      if (!senderIsolationApplied(event.systemPrompt, senderContext)) {
        api.logger.error?.("Rico guard blocked an iMessage run because trusted sender isolation was not present in the applied system prompt");
        return {
          outcome: "block",
          reason: "Verified iMessage sender isolation is required before model execution.",
          category: "sender_context_required",
        };
      }
      const sharedAudience = senderContext.isOwner !== true || senderContext.conversationType === "group";
      if (sharedAudience && !senderContexts.promptUnchanged(ctx, event.prompt, event.messages)) {
        api.logger.error?.("Rico guard blocked a shared iMessage run because another prompt context was injected");
        return {
          outcome: "block",
          reason: "Shared iMessage prompt isolation could not be verified.",
          category: "shared_prompt_context_changed",
        };
      }
      if (!sessionAttestations.verifyOrAttest({
        sessionId: ctx.sessionId,
        audienceFingerprint: senderContext.audienceFingerprint,
        messages: event.messages,
      })) {
        api.logger.error?.("Rico guard blocked an iMessage run because its session history requires a reset or belongs to another audience");
        return {
          outcome: "block",
          reason: "iMessage session history must be reset and re-attested before model execution.",
          category: "sender_session_reset_required",
        };
      }
      if (sharedAudience && senderContext.escalationCapability?.available === true &&
          !sharedEscalationProofs.attest(event, ctx, senderContext)) {
        api.logger.error?.("Rico guard blocked a shared run because its advertised escalation capability could not be attested");
        return {
          outcome: "block",
          reason: "Shared iMessage escalation context could not be verified.",
          category: "escalation_context_required",
        };
      }
      return;
    }, { priority: 1100 });

    api.on("before_tool_call", async (event, ctx) => {
      if (!isIMessageRun(event, ctx)) return;
      const senderContext = senderContexts.get({ ...ctx, runId: event.runId ?? ctx.runId });
      if (!senderContext) {
        return { block: true, blockReason: "Verified iMessage sender context is required for tool use." };
      }
      if (event.toolName === RICO_ESCALATION_TOOL_NAME) {
        try {
          if (!sharedEscalationProofs.allows(event, ctx, senderContext)) {
            throw new Error("shared escalation run proof unavailable");
          }
          const policy = readPolicy(policyPath, directory);
          if (!currentPolicyAllowsSharedEscalation(policy, senderContext)) {
            throw new Error("shared escalation policy proof unavailable");
          }
          if (senderContext.conversationType === "group") {
            const membership = verifyGroupMembership(policy, senderContext.groupTarget, await readIMessageGroups());
            if (!membership.matches) throw new Error("shared escalation group proof unavailable");
          }
          if (!sharedEscalationProofs.mintOrigin(event, ctx, senderContext)) {
            throw new Error("shared escalation origin proof unavailable");
          }
          return;
        } catch {
          return {
            block: true,
            blockReason: "Local verification is unavailable because exact sender, session, prompt, or audience proof did not pass.",
          };
        }
      }
      if (event.toolName === RICO_GROUP_EMAIL_TOOL_NAME) {
        if (senderContext.isOwner !== true || senderContext.conversationType !== "group") {
          return { block: true, blockReason: "Governed group email is available only to the exact owner in a verified group turn." };
        }
        try {
          const { outlook, groupAuthorizations } = await loadGroupEmailRuntime();
          const runId = String(event.runId ?? ctx.runId ?? "").trim();
          const toolCallId = String(event.toolCallId ?? ctx.toolCallId ?? "").trim();
          const origin = senderContexts.getOrigin({ runId });
          const policy = readPolicy(policyPath, directory);
          const liveGroups = await readIMessageGroups();
          const membership = verifyGroupMembership(policy, senderContext.groupTarget, liveGroups);
          const group = await groupAuthorizations.get(senderContext.groupTarget);
          const health = await outlook.health();
          if (!origin || !membership.matches || health.ok !== true || health.sendEnabled !== true ||
              senderContext.groupEmailCapability?.groupRevision !== group.revision) throw new Error("group email preflight unavailable");
          if (!groupEmailExecutions.authorize({
            runId,
            toolCallId,
            sessionKey: ctx.sessionKey,
            sessionId: ctx.sessionId,
            senderHandle: senderContext.senderHandle,
            senderIsOwner: true,
            groupTarget: senderContext.groupTarget,
            groupRevision: group.revision,
            participantHandles: group.participants,
            origin,
          })) throw new Error("duplicate group email tool call");
          return;
        } catch {
          return { block: true, blockReason: "Governed group email is unavailable because exact sender, group, profile, or Outlook proof did not pass." };
        }
      }
      if (senderContext.isOwner === true && senderContext.conversationType === "direct") return;
      return {
        block: true,
        blockReason: senderContext.conversationType === "group"
          ? "Tools are unavailable in a group-visible Rico conversation."
          : "Tools are unavailable in an approved contact conversation.",
      };
    }, { priority: 1100 });

    api.on("agent_end", async (_event, ctx) => {
      groupEmailExecutions.forgetRun(ctx.runId);
      sharedEscalationProofs.forget(ctx);
      senderContexts.forget(ctx);
    }, { priority: 1000 });

    api.on("reply_payload_sending", async (event, ctx) => {
      const disposition = internalRuntimePayloadDisposition(event, ctx);
      if (!disposition) return;
      if (disposition.action === "replace") {
        api.logger.warn?.(`Rico replaced internal runtime telemetry before external iMessage delivery: ${disposition.reason}`);
        return {
          payload: {
            text: disposition.replacement ?? RICO_GENERIC_RUNTIME_ERROR,
            ...(typeof event.payload?.replyToId === "string" ? { replyToId: event.payload.replyToId } : {}),
            ...(event.payload?.replyToTag === true ? { replyToTag: true } : {}),
            ...(event.payload?.replyToCurrent === true ? { replyToCurrent: true } : {}),
          },
          reason: "Internal runtime details were replaced with a provider-neutral error.",
        };
      }
      api.logger.warn?.(`Rico suppressed internal runtime telemetry from external iMessage delivery: ${disposition.reason}`);
      return {
        cancel: true,
        reason: "Internal runtime telemetry is not allowed in external iMessage delivery.",
      };
    }, { priority: 1200 });

    api.on("message_sending", async (event, ctx) => {
      if (ctx.channelId !== "imessage") return;
      try {
        if (isInternalModelRoutingNotice(event.content)) {
          api.logger.warn?.("Rico suppressed flattened internal model-routing telemetry from external iMessage delivery.");
          return { cancel: true, cancelReason: "Internal model-routing telemetry is not allowed in external iMessage delivery." };
        }
        const escalationDisclosure = internalEscalationMetadataReason(event.content);
        const sanitizedRuntimeError = isInternalModelBackendFailure(event.content) ? RICO_GENERIC_RUNTIME_ERROR : undefined;
        const sanitizedEscalation = escalationDisclosure ? RICO_ESCALATION_SAFE_REPLY : undefined;
        const outboundContent = sanitizedRuntimeError ?? sanitizedEscalation ?? event.content;
        if (sanitizedRuntimeError) {
          api.logger.warn?.("Rico replaced flattened internal runtime error before external iMessage delivery.");
        }
        if (sanitizedEscalation) {
          api.logger.warn?.(`Rico replaced internal escalation metadata before external iMessage delivery: ${escalationDisclosure}`);
        }
        const privateDisclosure = privateProvenanceDisclosureReason(outboundContent);
        if (privateDisclosure) {
          api.logger.warn?.(`Rico blocked outbound private-source provenance disclosure: ${privateDisclosure}`);
          return { cancel: true, cancelReason: "Rico cannot disclose or imply private conversation or recording provenance." };
        }
        const target = normalize(event.to);
        const policy = readPolicy(policyPath, directory);
        if (policy.paused === true) {
          return { cancel: true, cancelReason: "Rico communications are paused." };
        }
        const identity = outboundIdentity(policy, target);
        if (identity?.access !== "owner" && isInternalRuntimeStatusReply(outboundContent)) {
          api.logger.warn?.("Rico blocked an internal runtime status report from a non-owner iMessage audience.");
          return { cancel: true, cancelReason: "Internal runtime status is owner-only." };
        }
        if (identity?.access === "blocked") {
          return { cancel: true, cancelReason: "Recipient is blocked by Rico policy." };
        }
        if (identity?.kind === "group" && (!Array.isArray(identity.participants) || identity.participants.length === 0)) {
          return { cancel: true, cancelReason: "Group membership requires review before Rico can reply." };
        }
        if (identity?.kind === "group" && isOwnerRouteTrigger(outboundContent)) {
          return { cancel: true, cancelReason: "Rico group replies cannot begin with @rico because that prefix is reserved for owner commands." };
        }
        if (identity?.kind === "group") {
          const membership = verifyGroupMembership(policy, target, await readIMessageGroups());
          if (!membership.matches) {
            return { cancel: true, cancelReason: "Group membership changed and requires review before Rico can reply." };
          }
        }
        // Studio creates a grant for each explicitly reviewed send. Consume it
        // even when the target is already allowlisted so no valid grant lingers.
        if (consumeOwnerAuthorization(grantsDirectory, target, outboundContent)) {
          return sanitizedRuntimeError || sanitizedEscalation ? { content: outboundContent } : undefined;
        }
        if (identity && identity.access !== "blocked") {
          return sanitizedRuntimeError || sanitizedEscalation ? { content: outboundContent } : undefined;
        }
        api.logger.warn?.(`Rico guard blocked unapproved iMessage target: ${target}`);
        return { cancel: true, cancelReason: "Recipient is not approved and no owner-initiated send grant matched." };
      } catch (error) {
        api.logger.error?.(`Rico guard blocked iMessage because enforcement failed: ${error instanceof Error ? error.message : String(error)}`);
        return { cancel: true, cancelReason: "Rico recipient enforcement could not be verified (fail closed)." };
      }
    }, { priority: 1000 });
  },
});
