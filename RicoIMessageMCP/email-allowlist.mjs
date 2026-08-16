import fs from "node:fs";
import { ALLOWED_SENDER_ACCOUNTS } from "../RicoEmailGovernance/definition.mjs";
import { normalizeEmail } from "../RicoEmailGovernance/policy.mjs";
import { readPersonEmailAuthorizations } from "../RicoEmailGovernance/runtime-providers.mjs";
import { defaultEmailAuthorizationPath } from "./constants.mjs";
import { fail } from "./errors.mjs";

const ALLOWED_ACCESS = new Set(["approved", "trusted", "owner"]);

export function parseEmailAddress(raw) {
  const email = normalizeEmail(raw);
  if (!email) throw fail("target_invalid", "Send target must be an allowlisted email address.");
  return email;
}

export function loadEmailAuthorizations(filePath = defaultEmailAuthorizationPath()) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return readPersonEmailAuthorizations(filePath);
  } catch {
    throw fail("email_policy_unavailable", "Rico email authorizations are unavailable.");
  }
}

export function authorizeEmailRecipient({
  policy,
  authorizations = [],
  address,
  requireGovernedOutlook = false,
  from,
} = {}) {
  if (policy?.paused === true) {
    throw fail("paused", "Rico communications are paused.");
  }

  const email = parseEmailAddress(address);
  const requestedFrom = from == null || from === "" ? "" : parseEmailAddress(from);

  if (ALLOWED_SENDER_ACCOUNTS.includes(email)) {
    const senderAccount = resolveOwnerSender(requestedFrom);
    return {
      ok: true,
      email,
      kind: "owner",
      access: "owner",
      senderAccount,
      attachmentsAllowed: false,
    };
  }

  const matches = authorizations.filter((item) => (
    item?.email?.enabled === true && normalizeEmail(item.email.recipientEmail) === email
  ));
  if (matches.length > 1) {
    throw fail("recipient_ambiguous", "Recipient matches more than one Rico email authorization.");
  }
  if (matches.length === 1) {
    const authorization = matches[0];
    const senderAccount = normalizeEmail(authorization.email.senderAccount);
    if (!ALLOWED_SENDER_ACCOUNTS.includes(senderAccount)) {
      throw fail("email_sender_not_allowed", "Outlook sender is not an approved Rico account.");
    }
    if (requestedFrom && requestedFrom !== senderAccount) {
      throw fail("email_sender_not_allowed", "Outlook sender is not an approved Rico account.");
    }
    return {
      ok: true,
      email,
      kind: "person-authorization",
      access: "approved",
      senderAccount,
      profileId: authorization.profileId,
      attachmentsAllowed: authorization.email.attachmentsAllowed === true,
    };
  }

  if (!requireGovernedOutlook) {
    const identity = emailIdentity(policy, email);
    if (identity && ALLOWED_ACCESS.has(identity.access) && identity.access !== "blocked") {
      return {
        ok: true,
        email,
        kind: "recipient-guard",
        access: identity.access,
        senderAccount: resolveOwnerSender(requestedFrom),
        attachmentsAllowed: false,
      };
    }
  }

  throw fail("recipient_not_allowlisted", "Recipient is not on Rico's allowlist.");
}

function resolveOwnerSender(requestedFrom) {
  if (!requestedFrom) return ALLOWED_SENDER_ACCOUNTS[0];
  if (!ALLOWED_SENDER_ACCOUNTS.includes(requestedFrom)) {
    throw fail("email_sender_not_allowed", "Outlook sender is not an approved Rico account.");
  }
  return requestedFrom;
}

function emailIdentity(policy, email) {
  if (!policy || policy.schemaVersion !== 2 || !Array.isArray(policy.identities)) return null;
  const matches = policy.identities.filter((item) => (
    item && typeof item === "object" && normalizeEmail(item.target) === email
  ));
  if (matches.length !== 1) return null;
  return matches[0];
}
