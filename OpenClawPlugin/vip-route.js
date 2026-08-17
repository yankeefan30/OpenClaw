export const RICO_VIP_DIRECT_MODEL = "anthropic/claude-opus-4-8";
export const RICO_SHARED_LOCAL_MODEL = "lmstudio/qwen/qwen3.6-35b-a3b";

const VIP_ACCESS = new Set(["approved", "trusted", "owner"]);

export function isVipDirectAudience(context) {
  if (!context || context.conversationType !== "direct") return false;
  if (context.isOwner === true) return true;
  return VIP_ACCESS.has(String(context.access ?? "").toLowerCase());
}

/**
 * VIP and owner directs start Claude. Groups keep the shared local route.
 * Returning undefined leaves the host route unchanged.
 */
export function resolveVipDirectModel(context, sessionKey = "") {
  const key = String(sessionKey ?? "");
  const sessionLooksDirect = /:imessage:(?:default:)?direct(?:$|:)/i.test(key);
  if (isVipDirectAudience(context) || (sessionLooksDirect && isVipDirectAudience({
    ...context,
    conversationType: context?.conversationType ?? "direct",
  }))) {
    return RICO_VIP_DIRECT_MODEL;
  }
  return undefined;
}

export function vipSessionModelIsClaude(context, sessionKey = "") {
  const model = resolveVipDirectModel(context, sessionKey);
  return model === RICO_VIP_DIRECT_MODEL && model !== RICO_SHARED_LOCAL_MODEL;
}
