import {
  normalizeIMessageHandle,
  RicoEmailPolicyError,
  safeDisplayName,
  sha256,
  validatePersonEmailAuthorization,
} from "./policy.mjs";
import { validateGroupEmailAuthorization } from "./group-email-broker.mjs";

export const RICO_GROUP_EMAIL_TOOL_NAME = "rico_group_email_execute";

// This is the only model-facing surface. It deliberately contains no email
// address, sender account, group member list, or raw runtime identity field.
export const RICO_GROUP_EMAIL_TOOL_DEFINITION = deepFreeze({
  name: RICO_GROUP_EMAIL_TOOL_NAME,
  description: "Send one governed Outlook email from an authenticated approved Rico group request to explicitly mentioned approved people, or perform Rico's Janet meeting handoff.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["action", "recipients"],
    properties: {
      action: { type: "string", enum: ["email", "meeting_handoff"] },
      recipients: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["role", "profileId", "displayName", "mention"],
          properties: {
            role: { type: "string", enum: ["to", "cc"] },
            profileId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
            displayName: { type: "string", minLength: 1, maxLength: 100 },
            mention: { type: "string", minLength: 1, maxLength: 100 },
          },
        },
      },
      subject: { type: "string", minLength: 1, maxLength: 160 },
      body: { type: "string", minLength: 80, maxLength: 20_000 },
      attachments: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "mime", "byteSize", "sha256"],
          properties: {
            path: { type: "string" },
            mime: { type: "string" },
            byteSize: { type: "integer", minimum: 1, maximum: 26_214_400 },
            sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
        },
      },
    },
  },
});

/**
 * Tool handler seam. `runtimeContext` is supplied by the Gateway hook, never
 * by tool arguments. `verifyRequestOrigin` must consult the guard's private
 * run registry and return an immutable exact-origin proof. Profile and group
 * providers load private reviewed state by opaque IDs; the model never
 * supplies an address.
 */
export class GroupEmailToolExecutor {
  constructor({ broker, verifyRequestOrigin, authorizationProvider, groupAuthorizationProvider }) {
    if (!broker || typeof broker.send !== "function" || typeof broker.sendMeetingHandoff !== "function") {
      throw coded("group_email_tool_broker_missing");
    }
    if (typeof verifyRequestOrigin !== "function") throw coded("group_email_tool_origin_verifier_missing");
    if (!authorizationProvider || typeof authorizationProvider.list !== "function") {
      throw coded("group_email_tool_authorization_provider_missing");
    }
    if (!groupAuthorizationProvider || typeof groupAuthorizationProvider.get !== "function") {
      throw coded("group_email_tool_group_provider_missing");
    }
    this.broker = broker;
    this.verifyRequestOrigin = verifyRequestOrigin;
    this.authorizationProvider = authorizationProvider;
    this.groupAuthorizationProvider = groupAuthorizationProvider;
  }

  async execute({ runtimeContext, input }) {
    const toolInput = validateGroupEmailToolInput(input);
    const origin = validateRequestOriginProof(await this.verifyRequestOrigin(runtimeContext));
    const group = validateGroupEmailAuthorization(await this.groupAuthorizationProvider.get(origin.groupTarget));
    if (group.target !== origin.groupTarget || group.revision !== origin.groupRevision) {
      throw coded("group_email_tool_group_revision_mismatch");
    }
    const authorizations = validateAuthorizationArchive(await this.authorizationProvider.list());
    const byID = new Map(authorizations.map((item) => [item.profileId, item]));
    for (const recipient of toolInput.recipients) {
      const profile = byID.get(recipient.profileId);
      if (!profile || profile.displayName !== recipient.displayName) {
        throw coded("group_email_tool_profile_mismatch");
      }
      const candidates = matchingProfiles(authorizations, recipient.mention, origin.senderHandle);
      if (candidates.length !== 1 || candidates[0].profileId !== recipient.profileId) {
        throw coded(candidates.length > 1 ? "group_email_tool_profile_ambiguous" : "group_email_tool_profile_unresolved");
      }
    }
    const recipientDirectives = toolInput.recipients.map(({ role, mention }) => ({ role, mention }));
    const request = {
      inbound: {
        messageId: origin.messageId,
        conversationId: origin.conversationId,
        body: origin.body,
      },
      groupAuthorization: group,
      authorizations,
      recipientDirectives,
    };
    if (toolInput.action === "meeting_handoff") {
      return this.broker.sendMeetingHandoff(request);
    }
    return this.broker.send({
      ...request,
      draft: {
        subject: toolInput.subject,
        body: toolInput.body,
        attachments: toolInput.attachments,
      },
    });
  }
}

export function validateGroupEmailToolInput(input) {
  const value = requireObject(input, "group email tool input");
  const action = value.action;
  if (action !== "email" && action !== "meeting_handoff") throw coded("group_email_tool_action_invalid");
  const allowed = action === "email"
    ? ["action", "recipients", "subject", "body", "attachments"]
    : ["action", "recipients"];
  exactKeys(value, allowed, "group email tool input");
  if (!Array.isArray(value.recipients) || value.recipients.length < 1 || value.recipients.length > 20) {
    throw coded("group_email_tool_recipients_invalid");
  }
  const recipients = value.recipients.map((item) => {
    const recipient = requireObject(item, "group email tool recipient");
    exactKeys(recipient, ["role", "profileId", "displayName", "mention"], "group email tool recipient");
    if (recipient.role !== "to" && recipient.role !== "cc") throw coded("group_email_tool_role_invalid");
    const profileId = String(recipient.profileId ?? "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(profileId)) throw coded("group_email_tool_profile_id_invalid");
    const displayName = safeDisplayName(recipient.displayName);
    const mention = safeDisplayName(recipient.mention);
    if (!displayName || displayName !== recipient.displayName || !mention || mention !== recipient.mention) {
      throw coded("group_email_tool_display_value_invalid");
    }
    return Object.freeze({ role: recipient.role, profileId, displayName, mention });
  });
  if (new Set(recipients.map((item) => item.profileId)).size !== recipients.length) {
    throw coded("group_email_tool_profile_duplicate");
  }
  if (recipients.filter((item) => item.role === "to").length < 1) throw coded("group_email_tool_to_required");
  if (action === "meeting_handoff") return deepFreeze({ action, recipients });
  if (typeof value.subject !== "string" || typeof value.body !== "string" || !Array.isArray(value.attachments)) {
    throw coded("group_email_tool_draft_invalid");
  }
  return deepFreeze({
    action,
    recipients,
    subject: value.subject,
    body: value.body,
    attachments: value.attachments,
  });
}

export function validateRequestOriginProof(input) {
  const value = requireObject(input, "group email request origin proof");
  exactKeys(value, [
    "ok", "source", "channel", "conversationType", "runId", "messageId",
    "conversationId", "groupTarget", "groupRevision", "senderHandle", "body", "bodyHash",
  ], "group email request origin proof");
  if (value.ok !== true || value.source !== "rico-recipient-guard/v5"
      || value.channel !== "imessage" || value.conversationType !== "group") {
    throw coded("group_email_request_origin_unproven");
  }
  const runId = exactText(value.runId, 256, "group_email_origin_run_invalid", false);
  const messageId = exactText(value.messageId, 512, "group_email_origin_message_invalid", false);
  const conversationId = exactText(value.conversationId, 512, "group_email_origin_conversation_invalid", false);
  const groupTarget = normalizeGroupTarget(value.groupTarget);
  if (!groupTarget) throw coded("group_email_origin_target_invalid");
  const groupRevision = Number(value.groupRevision);
  if (!Number.isSafeInteger(groupRevision) || groupRevision < 1) throw coded("group_email_origin_revision_invalid");
  const senderHandle = normalizeIMessageHandle(value.senderHandle);
  if (!senderHandle) throw coded("group_email_origin_sender_invalid");
  const body = exactText(value.body, 4_000, "group_email_origin_body_invalid", true);
  const bodyHash = String(value.bodyHash ?? "").trim().toLowerCase();
  if (bodyHash !== sha256(body)) throw coded("group_email_origin_body_mismatch");
  return deepFreeze({
    ok: true,
    source: "rico-recipient-guard/v5",
    channel: "imessage",
    conversationType: "group",
    runId,
    messageId,
    conversationId,
    groupTarget,
    groupRevision,
    senderHandle,
    body,
    bodyHash,
  });
}

function validateAuthorizationArchive(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 100) throw coded("group_email_tool_authorizations_invalid");
  const values = input.map(validatePersonEmailAuthorization);
  if (new Set(values.map((item) => item.profileId)).size !== values.length
      || new Set(values.map((item) => item.principal.handle)).size !== values.length) {
    throw coded("group_email_tool_authorizations_ambiguous");
  }
  return values;
}

function matchingProfiles(profiles, mention, actorHandle) {
  const query = mention.toLocaleLowerCase("en-US");
  if (/^(?:i|me|myself)$/iu.test(query)) return profiles.filter((item) => item.principal.handle === actorHandle);
  return profiles.filter((profile) => {
    const name = safeDisplayName(profile.displayName).toLocaleLowerCase("en-US");
    return query === name || name.split(/\s+/u).includes(query);
  });
}

function normalizeGroupTarget(input) {
  const raw = String(input ?? "").normalize("NFC").trim();
  if (!/^chat_(?:id|guid|identifier):[^\u0000-\u001f\u007f-\u009f\s]{1,512}$/iu.test(raw)) return "";
  const separator = raw.indexOf(":");
  return `${raw.slice(0, separator).toLowerCase()}:${raw.slice(separator + 1)}`;
}

function exactText(input, maxCharacters, code, multiline) {
  const value = String(input ?? "").normalize("NFC").replace(/\r\n/gu, "\n").trim();
  if (!value || [...value].length > maxCharacters || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
      || /\r/u.test(value) || (!multiline && /\n/u.test(value))) throw coded(code);
  return value;
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw coded(`${label.replaceAll(" ", "_")}_invalid`);
  return value;
}

function exactKeys(value, keys, label) {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw coded(`${label.replaceAll(" ", "_")}_fields_invalid`);
  }
}

function coded(code) {
  return new RicoEmailPolicyError(code);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
