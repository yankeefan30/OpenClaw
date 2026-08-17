import os from "node:os";
import path from "node:path";
import {
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
  if (!policy || !Array.isArray(policy.identities)) return [];
  return policy.identities
    .filter((identity) => isVipDirectIdentity(identity, extraVipHandles))
    .map((identity) => normalize(identity.target))
    .filter(Boolean);
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
  const sessionKey = String(event?.sessionKey ?? ctx?.sessionKey ?? "");
  const direct = sessionKey.match(/:imessage:direct:([^:]+)(?:$|:)/i);
  const raw = ctx?.senderId ?? event?.senderId ?? direct?.[1];
  return normalize(raw);
}

export function isVipDirectTurn(event, ctx = {}, vipHandles = []) {
  const sessionKey = String(event?.sessionKey ?? ctx?.sessionKey ?? "").toLowerCase();
  if (sessionKey.includes(":imessage:group:")) return false;
  const handle = senderHandleFromContext(event, ctx);
  if (!handle || !vipHandles.includes(handle)) return false;
  return sessionKey.includes(":imessage:direct:") || String(ctx?.channelId ?? event?.channel ?? "").toLowerCase() === "imessage";
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
