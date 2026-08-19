import {
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  LINKEDIN_ARTICLE_NOTE,
  LOCAL_TOOL_NAMES,
  PRESSMASTER_ISSUER,
  PRESSMASTER_RESOURCE,
  SERVER_NAME,
  SERVER_VERSION,
} from "./constants.mjs";
import { fail, publicError } from "./errors.mjs";

export const TOOL_DEFINITIONS = [
  {
    name: "rico_pressmaster_health",
    description: "Rico-local Pressmaster MCP health. Hostname gate, auth source, and official MCP reachability. Never publishes.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "rico_pressmaster_whoami",
    description: "Workspace / identity from the official Pressmaster MCP after OAuth. Fails closed if no token is stored.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "rico_pressmaster_list_drafts",
    description: "List Pressmaster Content Library drafts by calling the official MCP tool that matches drafts/library listing. Never publishes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Optional search text forwarded to the official list tool if it accepts it." },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "rico_pressmaster_get_draft",
    description: "Get one Pressmaster draft/content item via the official MCP. Never publishes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", minLength: 1 },
      },
      required: ["id"],
    },
  },
  {
    name: "rico_pressmaster_create_or_update_draft",
    description: "Create or update a Pressmaster draft (LinkedIn long-form / article in the Content Library, Twin voice). Never publishes or schedules. Publish is a separate tool.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        format: { type: "string", description: "Preferred format, e.g. article or linkedin_post." },
        draftId: { type: "string", description: "Existing draft id for update." },
        brief: { type: "string" },
      },
    },
  },
  {
    name: "rico_pressmaster_list_channels",
    description: "List connected Pressmaster publish channels (confirm LinkedIn). Never publishes.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "rico_pressmaster_publish_or_schedule",
    description: "Explicit Pressmaster publish or schedule to a connected channel such as LinkedIn. Never implied by create. Tests and Polar QA should pass dryRun=true so nothing goes live.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        draftId: { type: "string" },
        channel: { type: "string", description: "Channel name, e.g. linkedin." },
        scheduledAt: { type: "string", description: "ISO-8601 future time. Omit to request immediate publish from the official tool." },
        dryRun: { type: "boolean", description: "If true, resolve the official tool and return the intended call without invoking Pressmaster." },
      },
      required: ["draftId"],
    },
  },
  {
    name: "rico_pressmaster_twin_generate",
    description: "Hand a brief to Pressmaster Twin / generate-from-brief if the official MCP exposes it. Returns a draft payload. Never publishes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        brief: { type: "string", minLength: 1 },
        format: { type: "string" },
      },
      required: ["brief"],
    },
  },
];

export async function callTool(runtime, name, args = {}) {
  switch (name) {
    case "rico_pressmaster_health":
      return health(runtime);
    case "rico_pressmaster_whoami":
      return whoami(runtime);
    case "rico_pressmaster_list_drafts":
      return proxyMapped(runtime, "list_drafts", args, { allowPublish: false });
    case "rico_pressmaster_get_draft":
      return proxyMapped(runtime, "get_draft", args, { allowPublish: false });
    case "rico_pressmaster_create_or_update_draft":
      return createOrUpdateDraft(runtime, args);
    case "rico_pressmaster_list_channels":
      return proxyMapped(runtime, "list_channels", args, { allowPublish: false });
    case "rico_pressmaster_publish_or_schedule":
      return publishOrSchedule(runtime, args);
    case "rico_pressmaster_twin_generate":
      return proxyMapped(runtime, "twin_generate", args, { allowPublish: false });
    default:
      return callOfficialIfKnown(runtime, name, args);
  }
}

export async function health(runtime = {}) {
  const host = runtime.hostIdentity ?? { hostname: "", localHostName: "" };
  const auth = runtime.authStatus ?? { available: false, source: "none" };
  let official = { discovered: false, tools: [] };
  if (runtime.upstream && auth.available && runtime.probeOfficial !== false) {
    try {
      const tools = await runtime.upstream.listOfficialTools();
      official = { discovered: true, tools: tools.map((tool) => tool.name) };
    } catch (error) {
      official = { discovered: false, error: publicError(error).error };
    }
  }
  return {
    ok: true,
    bridge: SERVER_NAME,
    version: SERVER_VERSION,
    host: {
      allowed: true,
      hostname: host.hostname || undefined,
      localHostName: host.localHostName || undefined,
    },
    auth: {
      available: Boolean(auth.available),
      source: auth.source ?? "none",
      keychainService: KEYCHAIN_SERVICE,
      keychainAccount: KEYCHAIN_ACCOUNT,
    },
    upstream: {
      resource: PRESSMASTER_RESOURCE,
      issuer: PRESSMASTER_ISSUER,
    },
    officialMcp: official,
    localTools: [...LOCAL_TOOL_NAMES],
    linkedin: { note: LINKEDIN_ARTICLE_NOTE },
    livePublish: false,
  };
}

export async function whoami(runtime = {}) {
  requireAuth(runtime);
  const init = await runtime.upstream.initialize();
  const tools = await runtime.upstream.listOfficialTools().catch(() => []);
  return {
    ok: true,
    workspaceBound: true,
    serverInfo: init?.serverInfo ?? null,
    instructions: typeof init?.instructions === "string" ? init.instructions : undefined,
    officialToolCount: Array.isArray(tools) ? tools.length : 0,
    officialTools: Array.isArray(tools) ? tools.map((tool) => tool.name) : [],
    linkedin: { note: LINKEDIN_ARTICLE_NOTE },
  };
}

export async function createOrUpdateDraft(runtime, args = {}) {
  rejectPublishArgs(args);
  return proxyMapped(runtime, "create_or_update_draft", args, { allowPublish: false });
}

export async function publishOrSchedule(runtime, args = {}) {
  requireAuth(runtime);
  const tools = await runtime.upstream.listOfficialTools();
  const match = resolveOfficialTool(tools, "publish_or_schedule");
  if (!match) {
    throw fail("official_tool_missing", officialMissingMessage("publish_or_schedule", tools));
  }
  if (args.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      forwarded: false,
      officialTool: match.name,
      wouldCall: {
        name: match.name,
        arguments: omitDryRun(args),
      },
      note: "No Pressmaster or LinkedIn publish was sent.",
    };
  }
  const result = await runtime.upstream.callOfficialTool(match.name, omitDryRun(args));
  return { ok: true, dryRun: false, forwarded: true, officialTool: match.name, result };
}

export async function listOfficialAndLocalTools(runtime) {
  const local = TOOL_DEFINITIONS;
  if (!runtime?.upstream || runtime?.authStatus?.available === false) return local;
  try {
    const official = await runtime.upstream.listOfficialTools();
    const seen = new Set(local.map((tool) => tool.name));
    const merged = [...local];
    for (const tool of official) {
      if (tool && typeof tool.name === "string" && !seen.has(tool.name)) {
        seen.add(tool.name);
        merged.push(tool);
      }
    }
    return merged;
  } catch {
    return local;
  }
}

export function resolveOfficialTool(tools, kind) {
  const ranked = (tools ?? [])
    .filter((tool) => tool && typeof tool.name === "string")
    .map((tool) => ({ tool, score: scoreTool(tool, kind) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.tool ?? null;
}

export function scoreTool(tool, kind) {
  const text = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
  const publish = isPublishLike(text);
  switch (kind) {
    case "list_drafts":
      if (publish) return 0;
      return scoreAll(text, "draft|content|library|article|post", "list|search|query|find") ? 3 : 0;
    case "get_draft":
      if (publish) return 0;
      return scoreAll(text, "draft|content|article|post", "get|read|fetch|retrieve|details") ? 3 : 0;
    case "create_or_update_draft":
      if (publish) return 0;
      return scoreAll(text, "draft|content|article|post", "create|update|upsert|write|compose|save|edit") ? 4 : 0;
    case "list_channels":
      if (publish) return 0;
      return scoreAll(text, "channel|destination|integration|account|connection|linkedin", "list|get|status|connected") ? 3 : 0;
    case "publish_or_schedule":
      return publish ? 5 : 0;
    case "twin_generate":
      if (publish) return 0;
      return scoreAll(text, "twin|brief|interview|generate|chat|voice", "generate|create|chat|interview|write|draft") ? 3 : 0;
    default:
      return 0;
  }
}

export function isPublishLike(text) {
  if (/\bpublish(ing)?\s+channels?\b/u.test(text)) return false;
  if (/\b(go[\s_-]?live|post[\s_-]?now)\b/u.test(text)) return true;
  if (/(^|[\s._-])(publish|schedule)(es|ed|ing|s)?($|[\s._-])/u.test(text)) return true;
  return false;
}

async function proxyMapped(runtime, kind, args, { allowPublish }) {
  requireAuth(runtime);
  const tools = await runtime.upstream.listOfficialTools();
  const match = resolveOfficialTool(tools, kind);
  if (!match) throw fail("official_tool_missing", officialMissingMessage(kind, tools));
  const text = `${match.name} ${match.description ?? ""}`.toLowerCase();
  if (!allowPublish && isPublishLike(text)) {
    throw fail("publish_not_implied", "Refusing to call a Pressmaster publish/schedule tool from a draft/read wrapper. Use rico_pressmaster_publish_or_schedule.");
  }
  const result = await runtime.upstream.callOfficialTool(match.name, args);
  return { ok: true, officialTool: match.name, result };
}

async function callOfficialIfKnown(runtime, name, args) {
  requireAuth(runtime);
  const tools = await runtime.upstream.listOfficialTools();
  const match = tools.find((tool) => tool.name === name);
  if (!match) throw fail("unknown_tool", `Unknown tool: ${name}`);
  const result = await runtime.upstream.callOfficialTool(name, args);
  return { ok: true, officialTool: name, result };
}

function requireAuth(runtime) {
  if (!runtime?.authStatus?.available || !runtime.upstream) {
    throw fail(
      "pressmaster_auth_missing",
      "No Pressmaster OAuth bearer is available. On original Rico only: node /Users/alan/OpenClawStudio/RicoPressmasterMcp/index.mjs --login (stores Keychain service rico-pressmaster-mcp / account alan). Polar may also inject PRESSMASTER_ACCESS_TOKEN in the local MCP env. The hosted app.pressmaster.ai/mcp OAuth connector cannot be used from Grok Bot because its redirect_uri is not registered.",
    );
  }
}

function rejectPublishArgs(args) {
  const keys = Object.keys(args ?? {});
  const forbidden = keys.filter((key) => /publish|schedule|live|goLive|posted/iu.test(key));
  if (forbidden.length) {
    throw fail("publish_not_implied", "Create/update draft does not accept publish or schedule fields. Use rico_pressmaster_publish_or_schedule.");
  }
  if (args?.status && /publish|schedule|live/iu.test(String(args.status))) {
    throw fail("publish_not_implied", "Create/update draft cannot set a published or scheduled status.");
  }
}

function officialMissingMessage(kind, tools) {
  const names = (tools ?? []).map((tool) => tool.name).filter(Boolean);
  return `Pressmaster's official MCP did not expose a tool that matches ${kind}. Official tools: ${names.length ? names.join(", ") : "(none discovered)"}. This server does not invent a Pressmaster REST API.`;
}

function omitDryRun(args) {
  const next = { ...args };
  delete next.dryRun;
  return next;
}

function scoreAll(text, ...groups) {
  return groups.every((group) => new RegExp(group, "u").test(text));
}
