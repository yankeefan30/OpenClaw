import os from "node:os";
import path from "node:path";
import {
  hasHumanInboundEvidence,
  isUnsolicitedOutboundTrigger,
  isVipDirectIdentity,
  normalize,
  readIstsVipHandles,
  readPolicy,
} from "../OpenClawPlugin/policy.js";

export const RICO_VIP_MODEL = "anthropic/claude-opus-4-8";
export const RICO_VIP_AGENT_ID = "rico-vip";

const QWEN_MODEL = /qwen|lmstudio\//i;

export function supportDirectory(homeDirectory = os.homedir()) {
  return path.join(homeDirectory, "Library", "Application Support", "OpenClaw Studio");
}

export function vipHandlesFromPolicy(policy, extraVipHandles = []) {
  if (!policy || !Array.isArray(policy.identities)) return extraVipHandles.map(normalize).filter(Boolean);
  const fromPolicy = policy.identities
    .filter((identity) => isVipDirectIdentity(identity, extraVipHandles))
    .map((identity) => normalize(identity.target))
    .filter(Boolean);
  return [...new Set([...fromPolicy, ...extraVipHandles.map(normalize).filter(Boolean)])];
}

export function loadVipHandles({ policyPath, directory } = {}) {
  const root = directory ?? supportDirectory();
  const file = policyPath ?? path.join(root, "rico-recipient-guard.json");
  try {
    const policy = readPolicy(file, root);
    return vipHandlesFromPolicy(policy, readIstsVipHandles(root));
  } catch {
    return readIstsVipHandles(root);
  }
}

export function senderHandleFromContext(event, ctx = {}) {
  // Session keys are not inbound. Live rico-shared keys look like
  // `imessage:default:direct:<handle>`; that suffix names the thread, it
  // does not prove the person just wrote.
  return normalize(ctx?.senderId ?? event?.senderId);
}

export function isVipDirectTurn(event, ctx = {}, vipHandles = []) {
  const sessionKey = String(event?.sessionKey ?? ctx?.sessionKey ?? "").toLowerCase();
  const defaultDirect = /:imessage:default:direct(?:$|:)/i.test(sessionKey);
  const namedDirect = /:imessage:direct:/i.test(sessionKey);
  if (sessionKey.includes(":imessage:group:") && !defaultDirect) return false;
  if (isUnsolicitedOutboundTrigger(event, ctx)) return false;
  const handle = senderHandleFromContext(event, ctx);
  if (!handle || !vipHandles.includes(handle)) return false;
  // A default:direct session, including default:direct:<handle>, is not a
  // VIP send. Claude pins only when this turn has a new human inbound.
  if (!hasHumanInboundEvidence(event, ctx)) return false;
  return namedDirect || defaultDirect || String(ctx?.channelId ?? event?.channel ?? "").toLowerCase() === "imessage";
}

export function selectedModelIsLocalQwen(event, ctx = {}) {
  const model = String(event?.model ?? event?.provider ?? ctx?.model ?? ctx?.selectedModel ?? "");
  return QWEN_MODEL.test(model);
}

export function vipModelOverride() {
  return {
    model: RICO_VIP_MODEL,
    modelOverride: RICO_VIP_MODEL,
    providerOverride: { allow: [RICO_VIP_MODEL] },
  };
}
