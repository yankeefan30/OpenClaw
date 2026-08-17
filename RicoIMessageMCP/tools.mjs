import { randomUUID } from "node:crypto";
import { authorizeRecipient, imessageChannelFromConfig, loadPolicy, parseSendTarget } from "./allowlist.mjs";
import { MAX_IDEMPOTENCY_CHARS, MAX_TEXT_CHARS, SERVER_NAME, SERVER_VERSION } from "./constants.mjs";
import { fail } from "./errors.mjs";
import { LOCAL_TOOL_DEFINITIONS, callLocalTool, isLocalTool } from "./local-tools.mjs";

export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: "rico_imessage_send",
    description: "Send one iMessage through Rico's local Gateway to an allowlisted E.164 number or chat_id. Strangers are rejected. Groups still need @rico on inbound; owner DMs do not.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["to", "text"],
      properties: {
        to: { type: "string", minLength: 1, maxLength: 64, description: "Allowlisted E.164 number or chat_id:<id>." },
        text: { type: "string", minLength: 1, maxLength: MAX_TEXT_CHARS, description: "Message body." },
        idempotencyKey: { type: "string", minLength: 1, maxLength: MAX_IDEMPOTENCY_CHARS, description: "Optional retry key. Reuse the same value to avoid a second send." },
      },
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "rico_imessage_health",
    description: "Report loopback OpenClaw Gateway reachability and iMessage probe.ok. Returns no secrets, tokens, or account identifiers.",
    inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "rico_imessage_can_send",
    description: "Check whether a recipient is on Rico's iMessage allowlist. Does not send a message and does not call Gateway send.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["to"],
      properties: {
        to: { type: "string", minLength: 1, maxLength: 64, description: "E.164 number or chat_id:<id> to check." },
      },
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  ...LOCAL_TOOL_DEFINITIONS,
]);

export async function callTool(runtime, name, args) {
  switch (name) {
    case "rico_imessage_send":
      return sendIMessage(runtime, args);
    case "rico_imessage_health":
      return health(runtime);
    case "rico_imessage_can_send":
      return canSend(runtime, args);
    default:
      if (isLocalTool(name)) return callLocalTool(runtime, name, args);
      throw fail("tool_not_found", "Unknown Rico iMessage tool.");
  }
}

function loadRecipientAuthorization(runtime, target) {
  let policy = runtime.policy;
  let policyError = false;
  if (!policy) {
    try {
      policy = loadPolicy(runtime.policyPath, runtime.supportDirectory);
    } catch {
      policyError = true;
    }
  }
  const channel = runtime.channel ?? imessageChannelFromConfig(runtime.config ?? {});
  return authorizeRecipient({
    policy,
    policyError,
    channel,
    target,
    knownApproved: runtime.knownApproved,
  });
}

export async function sendIMessage(runtime, args) {
  const to = parseSendTarget(args?.to);
  const text = sanitizeText(args?.text);
  const idempotencyKey = sanitizeIdempotency(args?.idempotencyKey);
  const authorized = loadRecipientAuthorization(runtime, to);
  if (typeof runtime.gateway?.sendIMessage !== "function") {
    throw fail("send_failed", "Gateway send is unavailable.");
  }
  const result = await runtime.gateway.sendIMessage({
    to: authorized.target,
    message: text,
    idempotencyKey,
  });
  return {
    ok: true,
    channel: "imessage",
    to: authorized.target,
    kind: authorized.kind,
    messageId: result.messageId,
    idempotencyKey,
  };
}

export async function health(runtime) {
  if (typeof runtime.gateway?.health !== "function" || typeof runtime.gateway?.imessageStatus !== "function") {
    throw fail("gateway_unavailable", "Gateway health is unavailable.");
  }
  try {
    await runtime.gateway.health();
  } catch {
    return { ok: false, gatewayOnline: false, imessageProbeOk: false, bridge: SERVER_NAME, version: SERVER_VERSION };
  }
  try {
    const probe = await runtime.gateway.imessageStatus({ probe: true });
    const imessageProbeOk = probe?.ok === true;
    return {
      ok: imessageProbeOk,
      gatewayOnline: true,
      imessageProbeOk,
      bridge: SERVER_NAME,
      version: SERVER_VERSION,
    };
  } catch {
    return { ok: false, gatewayOnline: true, imessageProbeOk: false, bridge: SERVER_NAME, version: SERVER_VERSION };
  }
}

export function canSend(runtime, args) {
  const to = parseSendTarget(args?.to);
  const authorized = loadRecipientAuthorization(runtime, to);
  return {
    ok: true,
    allowed: true,
    to: authorized.target,
    kind: authorized.kind,
  };
}

function sanitizeText(value) {
  const text = String(value ?? "").normalize("NFC");
  if (!text.trim()) throw fail("text_invalid", "Message text is required.");
  if ([...text].length > MAX_TEXT_CHARS) throw fail("text_invalid", "Message text is too long.");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw fail("text_invalid", "Message text contains disallowed control characters.");
  }
  return text;
}

function sanitizeIdempotency(value) {
  if (value == null || value === "") return `rico-imessage-mcp-${randomUUID()}`;
  const key = String(value).trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) {
    throw fail("idempotency_invalid", "idempotencyKey must be 1-128 URL-safe characters.");
  }
  return key;
}
