import { normalize, outboundIdentity, readPolicy } from "../OpenClawPlugin/policy.js";
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

export function authorizeRecipient({ policy, channel = {}, target }) {
  if (!policy || policy.schemaVersion !== 2 || !Array.isArray(policy.identities)) {
    throw fail("policy_unavailable", "Rico recipient policy is unavailable.");
  }
  if (policy.paused === true) {
    throw fail("paused", "Rico communications are paused.");
  }

  const expected = parseSendTarget(target);
  const identity = outboundIdentity(policy, expected);
  if (!identity || identity.access === "blocked" || identity.kind === "ambiguous") {
    throw fail("recipient_not_allowlisted", "Recipient is not on Rico's allowlist.");
  }
  if (!ALLOWED_ACCESS.has(identity.access)) {
    throw fail("recipient_not_allowlisted", "Recipient is not on Rico's allowlist.");
  }

  // Native allowFrom is defense in depth for strangers. An already
  // approved/trusted/owner identity in the recipient-guard policy is
  // authoritative and must not be dropped because Studio's native list is stale.
  if (E164.test(expected) && Array.isArray(channel.allowFrom) && !ALLOWED_ACCESS.has(identity.access)) {
    const allowed = new Set(channel.allowFrom.map((item) => normalize(item)).filter(Boolean));
    if (!allowed.has(expected)) {
      throw fail("recipient_not_allowlisted", "Recipient is not on Rico's allowlist.");
    }
  }

  // Native groups/allowFrom are extra approvals, never a second deny gate.

  return {
    ok: true,
    target: expected,
    kind: identity.kind === "group" ? "group" : "direct",
    access: identity.access,
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
