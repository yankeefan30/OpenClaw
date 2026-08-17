import { authorizeOutboundSend, normalize, outboundIdentity, readPolicy } from "../OpenClawPlugin/policy.js";
import { fail } from "./errors.mjs";

const ALLOWED_ACCESS = new Set(["approved", "trusted", "owner"]);
const E164 = /^\+[1-9]\d{6,14}$/;
const CHAT_ID = /^chat_id:[1-9]\d*$/;

export function parseSendTarget(raw) {
  const target = normalize(raw);
  if (!target) throw fail("target_invalid", "Send target must be an allowlisted E.164 number or chat_id.");
  if (E164.test(target) || CHAT_ID.test(target)) return target;
  throw fail("target_invalid", "Send target must be an allowlisted E.164 number or chat_id.");
}

export function authorizeRecipient({ policy, policyError = false, channel = {}, target, knownApproved = [] }) {
  const expected = parseSendTarget(target);
  const allowFrom = Array.isArray(channel.allowFrom) ? channel.allowFrom : [];
  const decision = authorizeOutboundSend({
    target: expected,
    policy,
    policyError,
    allowFrom,
    knownApproved,
  });
  if (!decision.allow) {
    throw fail("recipient_not_allowlisted", "Recipient is not on Rico's allowlist.");
  }
  const identity = policy ? outboundIdentity(policy, decision.target) : undefined;
  return {
    ok: true,
    target: expected,
    kind: identity?.kind === "group" ? "group" : "direct",
    access: ALLOWED_ACCESS.has(identity?.access) ? identity.access : "approved",
  };
}

export function loadPolicy(policyPath, supportDirectory) {
  try {
    return readPolicy(policyPath, supportDirectory);
  } catch {
    throw fail("policy_unavailable", "Rico recipient policy is unavailable.");
  }
}

export function imessageChannelFromConfig(config) {
  const channel = config?.channels?.imessage;
  if (!channel || typeof channel !== "object" || Array.isArray(channel)) return {};
  return {
    allowFrom: Array.isArray(channel.allowFrom) ? channel.allowFrom : undefined,
    groups: channel.groups && typeof channel.groups === "object" && !Array.isArray(channel.groups)
      ? channel.groups
      : undefined,
  };
}
