import { canonicalStringify, sha256, StoreError } from "./state-store.js";

export const PLUGIN_VERSION = "0.1.0";
export const CONTRACT_VERSION = "1.0.0";
export const MISSION_SCHEMA = "rico.autonomy.mission";
export const MISSION_SCHEMA_VERSION = 1;
export const MODES = Object.freeze(["shadow", "suggest", "bounded"]);
export const PHASES = Object.freeze(["observe", "plan", "policy", "execute", "verify", "complete", "escalate"]);
export const HOOKS = Object.freeze([
  "before_agent_run",
  "agent_end",
  "before_tool_call",
  "after_tool_call",
  "message_sending",
  "message_sent",
]);

const DEFAULT_BUDGETS = Object.freeze({
  runsPerDay: 10,
  toolCallsPerRun: 25,
  toolCallsPerDay: 100,
  writeCallsPerDay: 20,
  outboundPerDay: 5,
  runtimeSecondsPerRun: 900,
});

const ALLOWED_TRIGGERS = new Set(["manual", "cron", "heartbeat", "webhook", "event", "scheduled", "background"]);
const MANIFEST_KEYS = new Set([
  "schema", "schemaVersion", "id", "revision", "title", "objective", "mode", "selectors", "tools",
  "outbound", "budgets", "completion", "escalation", "integrity", "signature",
  "timeWindow",
]);

export class GovernorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GovernorError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new GovernorError(code, message);
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_MISSION", `${label} must be an object.`);
  return value;
}

function noExtraKeys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail("INVALID_MISSION", `${label}.${key} is not supported.`);
}

function boundedString(value, label, { min = 1, max = 200, pattern } = {}) {
  if (typeof value !== "string") fail("INVALID_MISSION", `${label} must be a string.`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max || (pattern && !pattern.test(normalized))) {
    fail("INVALID_MISSION", `${label} is invalid.`);
  }
  return normalized;
}

function stringArray(value, label, { maxItems = 100, itemMax = 300, pattern } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) fail("INVALID_MISSION", `${label} must be an array with at most ${maxItems} items.`);
  const result = value.map((item, index) => boundedString(item, `${label}[${index}]`, { max: itemMax, pattern }));
  if (new Set(result).size !== result.length) fail("INVALID_MISSION", `${label} must not contain duplicates.`);
  return result.sort();
}

function positiveInteger(value, label, fallback, maximum) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximum) fail("INVALID_MISSION", `${label} must be an integer between 1 and ${maximum}.`);
  return candidate;
}

function normalizeTimeWindow(value) {
  if (value === undefined) return undefined;
  const raw = plainObject(value, "mission.timeWindow");
  noExtraKeys(raw, new Set(["timezone", "startLocal", "endLocal", "allowedWeekdays"]), "mission.timeWindow");
  const timezone = boundedString(raw.timezone, "mission.timeWindow.timezone", { max: 100, pattern: /^[A-Za-z0-9_+\-/]+$/ });
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
  } catch {
    fail("INVALID_MISSION", "mission.timeWindow.timezone must be a supported IANA timezone.");
  }
  const clockPattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  const startLocal = boundedString(raw.startLocal, "mission.timeWindow.startLocal", { max: 5, pattern: clockPattern });
  const endLocal = boundedString(raw.endLocal, "mission.timeWindow.endLocal", { max: 5, pattern: clockPattern });
  if (startLocal === endLocal) fail("INVALID_MISSION", "mission.timeWindow start and end must differ.");
  const allowedWeekdays = raw.allowedWeekdays === undefined ? [1, 2, 3, 4, 5, 6, 7] : raw.allowedWeekdays;
  if (!Array.isArray(allowedWeekdays) || allowedWeekdays.length < 1 || allowedWeekdays.length > 7 || allowedWeekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
    fail("INVALID_MISSION", "mission.timeWindow.allowedWeekdays must contain ISO weekday numbers 1 through 7.");
  }
  if (new Set(allowedWeekdays).size !== allowedWeekdays.length) fail("INVALID_MISSION", "mission.timeWindow.allowedWeekdays must be unique.");
  return { timezone, startLocal, endLocal, allowedWeekdays: [...allowedWeekdays].sort((a, b) => a - b) };
}

function localWindowState(timeWindow, timestamp) {
  if (!timeWindow) return { allowed: true };
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: timeWindow.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const weekday = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday];
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  const toMinute = (clock) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
  const start = toMinute(timeWindow.startLocal);
  const end = toMinute(timeWindow.endLocal);
  if (start < end) return { allowed: timeWindow.allowedWeekdays.includes(weekday) && minute >= start && minute < end };
  if (minute >= start) return { allowed: timeWindow.allowedWeekdays.includes(weekday) };
  const previousWeekday = weekday === 1 ? 7 : weekday - 1;
  return { allowed: minute < end && timeWindow.allowedWeekdays.includes(previousWeekday) };
}

function manifestPayload(manifest) {
  const { integrity: _integrity, signature: _signature, ...payload } = manifest;
  return payload;
}

export function computePolicyHash(manifest) {
  return sha256({
    schema: manifest.schema,
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    revision: manifest.revision,
    mode: manifest.mode,
    selectors: manifest.selectors,
    tools: manifest.tools,
    outbound: manifest.outbound,
    budgets: manifest.budgets,
    completion: manifest.completion,
    escalation: manifest.escalation,
    timeWindow: manifest.timeWindow,
  });
}

export function normalizeMission(input) {
  const raw = plainObject(input, "mission");
  noExtraKeys(raw, MANIFEST_KEYS, "mission");
  if (raw.schema !== MISSION_SCHEMA || raw.schemaVersion !== MISSION_SCHEMA_VERSION) {
    fail("MISSION_SCHEMA_MISMATCH", `Mission schema must be ${MISSION_SCHEMA} version ${MISSION_SCHEMA_VERSION}.`);
  }
  const id = boundedString(raw.id, "mission.id", { max: 80, pattern: /^[a-z][a-z0-9-]*$/ });
  const revision = positiveInteger(raw.revision, "mission.revision", undefined, 1_000_000_000);
  const title = boundedString(raw.title, "mission.title", { max: 120 });
  const objective = boundedString(raw.objective, "mission.objective", { max: 4000 });
  if (!MODES.includes(raw.mode)) fail("INVALID_MISSION", "mission.mode must be shadow, suggest, or bounded.");

  const selectorsRaw = plainObject(raw.selectors, "mission.selectors");
  noExtraKeys(selectorsRaw, new Set(["agentIds", "sessionKeys", "jobIds", "triggers", "governManualRuns"]), "mission.selectors");
  const selectors = {
    agentIds: stringArray(selectorsRaw.agentIds, "mission.selectors.agentIds", { pattern: /^[A-Za-z0-9._:-]+$/ }),
    sessionKeys: stringArray(selectorsRaw.sessionKeys, "mission.selectors.sessionKeys", { maxItems: 200 }),
    jobIds: stringArray(selectorsRaw.jobIds, "mission.selectors.jobIds", { pattern: /^[A-Za-z0-9._:-]+$/ }),
    triggers: stringArray(selectorsRaw.triggers, "mission.selectors.triggers", { pattern: /^[a-z-]+$/ }),
    governManualRuns: selectorsRaw.governManualRuns === true,
  };
  if (selectors.triggers.some((trigger) => !ALLOWED_TRIGGERS.has(trigger))) fail("INVALID_MISSION", "Mission contains an unsupported trigger.");
  if (selectors.agentIds.length + selectors.sessionKeys.length + selectors.jobIds.length + selectors.triggers.length === 0) {
    fail("INVALID_MISSION", "Mission must have at least one exact selector.");
  }

  if (!Array.isArray(raw.tools) || raw.tools.length > 200) fail("INVALID_MISSION", "mission.tools must be an array with at most 200 entries.");
  const seenTools = new Set();
  const tools = raw.tools.map((entry, index) => {
    const tool = plainObject(entry, `mission.tools[${index}]`);
    noExtraKeys(tool, new Set(["name", "effect", "decision"]), `mission.tools[${index}]`);
    const name = boundedString(tool.name, `mission.tools[${index}].name`, { max: 128, pattern: /^[A-Za-z0-9_.:-]+$/ });
    if (name.includes("*") || seenTools.has(name)) fail("INVALID_MISSION", "Tool names must be exact and unique.");
    seenTools.add(name);
    if (!["read", "write", "external"].includes(tool.effect)) fail("INVALID_MISSION", `mission.tools[${index}].effect is invalid.`);
    const decision = tool.decision ?? "allow";
    if (!["allow", "deny"].includes(decision)) fail("INVALID_MISSION", `mission.tools[${index}].decision is invalid.`);
    return { name, effect: tool.effect, decision };
  }).sort((left, right) => left.name.localeCompare(right.name));

  const outboundRaw = raw.outbound === undefined ? {} : plainObject(raw.outbound, "mission.outbound");
  noExtraKeys(outboundRaw, new Set(["channels", "targets"]), "mission.outbound");
  const outbound = {
    channels: stringArray(outboundRaw.channels, "mission.outbound.channels", { maxItems: 30, pattern: /^[A-Za-z0-9._:-]+$/ }).map((item) => item.toLowerCase()),
    targets: stringArray(outboundRaw.targets, "mission.outbound.targets", { maxItems: 1000 }),
  };

  const budgetRaw = raw.budgets === undefined ? {} : plainObject(raw.budgets, "mission.budgets");
  noExtraKeys(budgetRaw, new Set(Object.keys(DEFAULT_BUDGETS)), "mission.budgets");
  const budgets = {
    runsPerDay: positiveInteger(budgetRaw.runsPerDay, "mission.budgets.runsPerDay", DEFAULT_BUDGETS.runsPerDay, 10_000),
    toolCallsPerRun: positiveInteger(budgetRaw.toolCallsPerRun, "mission.budgets.toolCallsPerRun", DEFAULT_BUDGETS.toolCallsPerRun, 10_000),
    toolCallsPerDay: positiveInteger(budgetRaw.toolCallsPerDay, "mission.budgets.toolCallsPerDay", DEFAULT_BUDGETS.toolCallsPerDay, 100_000),
    writeCallsPerDay: positiveInteger(budgetRaw.writeCallsPerDay, "mission.budgets.writeCallsPerDay", DEFAULT_BUDGETS.writeCallsPerDay, 100_000),
    outboundPerDay: positiveInteger(budgetRaw.outboundPerDay, "mission.budgets.outboundPerDay", DEFAULT_BUDGETS.outboundPerDay, 10_000),
    runtimeSecondsPerRun: positiveInteger(budgetRaw.runtimeSecondsPerRun, "mission.budgets.runtimeSecondsPerRun", DEFAULT_BUDGETS.runtimeSecondsPerRun, 86_400),
  };

  const completionRaw = raw.completion === undefined ? {} : plainObject(raw.completion, "mission.completion");
  noExtraKeys(completionRaw, new Set(["criteria", "evidenceRequired"]), "mission.completion");
  const completion = {
    criteria: stringArray(completionRaw.criteria, "mission.completion.criteria", { maxItems: 50, itemMax: 500 }),
    evidenceRequired: completionRaw.evidenceRequired !== false,
  };
  const escalationRaw = raw.escalation === undefined ? {} : plainObject(raw.escalation, "mission.escalation");
  noExtraKeys(escalationRaw, new Set(["conditions"]), "mission.escalation");
  const escalation = { conditions: stringArray(escalationRaw.conditions, "mission.escalation.conditions", { maxItems: 50, itemMax: 500 }) };

  let signature;
  if (raw.signature !== undefined && raw.signature !== null) {
    const candidate = plainObject(raw.signature, "mission.signature");
    noExtraKeys(candidate, new Set(["algorithm", "keyId", "value"]), "mission.signature");
    if (candidate.algorithm !== "ed25519") fail("INVALID_MISSION", "Only Ed25519 mission signatures are supported.");
    signature = {
      algorithm: "ed25519",
      keyId: boundedString(candidate.keyId, "mission.signature.keyId", { max: 160, pattern: /^[A-Za-z0-9._:-]+$/ }),
      value: boundedString(candidate.value, "mission.signature.value", { max: 512, pattern: /^[A-Za-z0-9+/=_-]+$/ }),
    };
  }

  const timeWindow = normalizeTimeWindow(raw.timeWindow);
  if (raw.mode === "bounded" && !timeWindow) fail("INVALID_MISSION", "Bounded missions require an enforced timeWindow.");
  const normalized = {
    schema: MISSION_SCHEMA,
    schemaVersion: MISSION_SCHEMA_VERSION,
    id,
    revision,
    title,
    objective,
    mode: raw.mode,
    selectors,
    tools,
    outbound,
    budgets,
    completion,
    escalation,
    ...(timeWindow ? { timeWindow } : {}),
    ...(signature ? { signature } : {}),
  };
  const manifestHash = sha256(manifestPayload(normalized));
  if (raw.integrity !== undefined) {
    const integrity = plainObject(raw.integrity, "mission.integrity");
    noExtraKeys(integrity, new Set(["algorithm", "manifestHash"]), "mission.integrity");
    if (integrity.algorithm !== "sha256" || integrity.manifestHash !== manifestHash) fail("MISSION_HASH_MISMATCH", "Mission integrity hash does not match its canonical payload.");
  }
  normalized.integrity = { algorithm: "sha256", manifestHash };
  return { manifest: normalized, manifestHash, policyHash: computePolicyHash(normalized) };
}

function operationKey(value) {
  return boundedString(value, "idempotencyKey", { min: 8, max: 200, pattern: /^[A-Za-z0-9._:-]+$/ });
}

function requestedRevision(value) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) fail("INVALID_PARAMS", "expectedRevision must be a positive integer.");
  return value;
}

function dayKey(now) {
  return new Date(now).toISOString().slice(0, 10);
}

function publicRecord(record) {
  if (!record) return undefined;
  return structuredClone({
    id: record.id,
    revision: record.revision,
    manifestRevision: record.manifest.revision,
    status: record.status,
    state: record.status,
    outcome: record.manifest.objective,
    phase: record.phase,
    mode: record.manifest.mode,
    title: record.manifest.title,
    objective: record.manifest.objective,
    policyHash: record.policyHash,
    manifestHash: record.manifestHash,
    signature: record.manifest.signature ? { present: true, algorithm: record.manifest.signature.algorithm, keyId: record.manifest.signature.keyId, verified: false } : { present: false, verified: false },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    activatedAt: record.activatedAt,
    pausedAt: record.pausedAt,
    checkpoint: record.checkpoint,
    budget: record.manifest.budgets,
    usage: { runs: 0, toolCalls: 0, writeCalls: 0, outbound: 0 },
    evidence: record.checkpoint?.evidence ?? [],
    evidenceCount: record.checkpoint?.evidence?.length ?? 0,
    exceptions: record.status === "paused" ? [{ code: "mission_paused", message: "Mission is paused.", at: record.pausedAt }] : [],
    exceptionCount: record.status === "paused" ? 1 : 0,
    allowedActions: record.manifest.tools.filter((tool) => tool.decision === "allow").map((tool) => tool.name),
    prohibitedActions: [...record.manifest.tools.filter((tool) => tool.decision === "deny").map((tool) => tool.name), "Any unlisted tool"],
    successCriteria: record.manifest.completion.criteria,
    triggerSummary: [
      ...record.manifest.selectors.triggers,
      ...record.manifest.selectors.jobIds.map((id) => `job:${id}`),
      ...record.manifest.selectors.sessionKeys.map((id) => `session:${id}`),
      ...record.manifest.selectors.agentIds.map((id) => `agent:${id}`),
      ...(record.manifest.timeWindow ? [`${record.manifest.timeWindow.startLocal}-${record.manifest.timeWindow.endLocal} ${record.manifest.timeWindow.timezone}`] : []),
    ].join(", ") || "Exact selector binding",
    manifest: record.manifest,
  });
}

function compatibleDecision(decision) {
  const allowed = decision.outcome === "allow";
  const approval = decision.outcome === "approval";
  return {
    ...decision,
    allowed,
    eligible: allowed || approval,
    decision: decision.outcome,
    status: allowed ? "eligible" : approval ? "approval-required" : "blocked",
    reason: decision.reason,
    requiredApprovals: approval ? ["operator-allow-once"] : [],
    policyVersion: CONTRACT_VERSION,
  };
}

function evidenceArray(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) fail("INVALID_PARAMS", "evidence must contain at most 100 entries.");
  const seen = new Set();
  return value.map((raw, index) => {
    const item = plainObject(raw, `evidence[${index}]`);
    noExtraKeys(item, new Set(["id", "digest", "kind"]), `evidence[${index}]`);
    const id = boundedString(item.id, `evidence[${index}].id`, { max: 160, pattern: /^[A-Za-z0-9._:-]+$/ });
    const digest = boundedString(item.digest, `evidence[${index}].digest`, { max: 71, pattern: /^(?:sha256:)?[a-f0-9]{64}$/ });
    const kind = item.kind === undefined ? "artifact" : boundedString(item.kind, `evidence[${index}].kind`, { max: 40, pattern: /^[a-z][a-z0-9_-]*$/ });
    if (seen.has(id)) fail("INVALID_PARAMS", "Evidence ids must be unique.");
    seen.add(id);
    return { id, digest: digest.startsWith("sha256:") ? digest : `sha256:${digest}`, kind };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function triggerIsAutonomous(trigger, jobId) {
  if (jobId) return true;
  return ["cron", "heartbeat", "webhook", "event", "scheduled", "background"].includes(String(trigger ?? "").toLowerCase());
}

function isOrdinaryInteractiveChannel(channel) {
  return channel === "imessage" || channel === "sms";
}

function selectorScore(record, context) {
  const selectors = record.manifest.selectors;
  if (context.jobId && selectors.jobIds.includes(context.jobId)) return 100;
  if (context.sessionKey && selectors.sessionKeys.includes(context.sessionKey)) return 90;
  const trigger = String(context.trigger ?? "").toLowerCase();
  if (context.agentId && selectors.agentIds.includes(context.agentId)) {
    if (trigger && selectors.triggers.includes(trigger)) return 80;
    if (triggerIsAutonomous(trigger, context.jobId) && selectors.triggers.length === 0) return 70;
    if (!triggerIsAutonomous(trigger, context.jobId) && selectors.governManualRuns) return 60;
  }
  if (trigger && selectors.triggers.includes(trigger) && selectors.agentIds.length === 0) return 50;
  return 0;
}

function counterEntry(state, missionId, now) {
  const key = dayKey(now);
  state.counters[key] ??= {};
  state.counters[key][missionId] ??= { runs: 0, toolCalls: 0, writeCalls: 0, outbound: 0, byRun: {} };
  const keys = Object.keys(state.counters).sort();
  for (const stale of keys.slice(0, Math.max(0, keys.length - 31))) delete state.counters[stale];
  return state.counters[key][missionId];
}

function checkBudget(counter, budgets, kind, runId) {
  if (kind === "run" && counter.runs >= budgets.runsPerDay) return "Daily run budget exhausted.";
  if (kind === "tool") {
    if (counter.toolCalls >= budgets.toolCallsPerDay) return "Daily tool-call budget exhausted.";
    if ((counter.byRun[runId] ?? 0) >= budgets.toolCallsPerRun) return "Per-run tool-call budget exhausted.";
  }
  if (kind === "write" && counter.writeCalls >= budgets.writeCallsPerDay) return "Daily write-call budget exhausted.";
  if (kind === "outbound" && counter.outbound >= budgets.outboundPerDay) return "Daily outbound budget exhausted.";
  return undefined;
}

const PHASE_TRANSITIONS = Object.freeze({
  observe: new Set(["plan", "escalate"]),
  plan: new Set(["policy", "escalate"]),
  policy: new Set(["execute", "plan", "escalate"]),
  execute: new Set(["verify", "escalate"]),
  verify: new Set(["complete", "plan", "escalate"]),
  complete: new Set(["observe"]),
  escalate: new Set(["plan", "complete", "observe"]),
});

export class AutonomyGovernor {
  constructor(store, { now = () => Date.now(), conversationAccessConfigured = false } = {}) {
    this.store = store;
    this.now = now;
    this.conversationAccessConfigured = conversationAccessConfigured === true;
  }

  get healthy() {
    return this.store.healthy === true && this.conversationAccessConfigured === true && Object.values(this.store.permissions()).every((entry) => entry.secure && !entry.symlink);
  }

  healthReasons() {
    const reasons = [...(this.store.healthReasons ?? [])];
    if (!this.conversationAccessConfigured) reasons.push("Conversation-access configuration is required for before_agent_run enforcement.");
    for (const [name, value] of Object.entries(this.store.permissions())) if (!value.secure || value.symlink) reasons.push(`${name} permissions are not private.`);
    return [...new Set(reasons)];
  }

  status() {
    const state = this.store.snapshot();
    const permissionDetails = this.store.permissions();
    return {
      contractVersion: CONTRACT_VERSION,
      version: PLUGIN_VERSION,
      schema: { mission: MISSION_SCHEMA_VERSION, state: 1, ledger: 1 },
      healthy: this.healthy,
      healthReasons: this.healthReasons(),
      globalPaused: state.globalPaused !== false,
      activeMissionCount: Object.values(state.missions ?? {}).filter((record) => record.status === "active").length,
      policyHashes: Object.fromEntries(Object.values(state.missions ?? {}).map((record) => [record.id, record.policyHash])),
      permissions: {
        directory: permissionDetails.directory.secure && !permissionDetails.directory.symlink,
        state: permissionDetails.state.secure && !permissionDetails.state.symlink,
        ledger: permissionDetails.ledger.secure && !permissionDetails.ledger.symlink,
      },
      permissionDetails,
      hooksRegistered: [...HOOKS],
      conversationAccess: { required: true, configured: this.conversationAccessConfigured },
      enforcement: { verified: true, authority: "gateway", contractVersion: CONTRACT_VERSION },
      stateRevision: state.revision ?? 0,
      ledgerSequence: state.ledger?.sequence ?? 0,
    };
  }

  listMissions() {
    this.store.assertHealthy();
    const state = this.store.snapshot();
    const today = state.counters[dayKey(this.now())] ?? {};
    const missions = Object.values(state.missions).sort((a, b) => a.id.localeCompare(b.id)).map((record) => {
      const presented = publicRecord(record);
      const usage = today[record.id] ?? {};
      presented.usage = {
        runs: usage.runs ?? 0,
        toolCalls: usage.toolCalls ?? 0,
        writeCalls: usage.writeCalls ?? 0,
        outbound: usage.outbound ?? 0,
      };
      return presented;
    });
    return { missions, stateRevision: state.revision };
  }

  getMission(id) {
    this.store.assertHealthy();
    const missionId = boundedString(id, "id", { max: 80, pattern: /^[a-z][a-z0-9-]*$/ });
    const record = this.store.snapshot().missions[missionId];
    if (!record) fail("NOT_FOUND", "Mission was not found.");
    const state = this.store.snapshot();
    const mission = publicRecord(record);
    const usage = state.counters[dayKey(this.now())]?.[record.id] ?? {};
    mission.usage = { runs: usage.runs ?? 0, toolCalls: usage.toolCalls ?? 0, writeCalls: usage.writeCalls ?? 0, outbound: usage.outbound ?? 0 };
    return { mission };
  }

  events(params = {}) {
    if (params.missionId !== undefined) boundedString(params.missionId, "missionId", { max: 80, pattern: /^[a-z][a-z0-9-]*$/ });
    return this.store.readEvents(params);
  }

  #withIdempotency(method, params, eventType, details, mutate) {
    const key = operationKey(params.idempotencyKey);
    const fingerprintInput = { ...params };
    delete fingerprintInput.idempotencyKey;
    const fingerprint = sha256({ method, params: fingerprintInput });
    const current = this.store.snapshot().operations[key];
    if (current) {
      if (current.method !== method || current.fingerprint !== fingerprint) fail("IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different operation.");
      return { ...structuredClone(current.result), idempotentReplay: true };
    }
    const timestamp = new Date(this.now()).toISOString();
    const { result } = this.store.transact(eventType, details, (state) => {
      const response = mutate(state, timestamp);
      state.operations[key] = { method, fingerprint, createdAt: timestamp, result: { ...structuredClone(response), idempotentReplay: false } };
      const operationKeys = Object.entries(state.operations).sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt));
      for (const [stale] of operationKeys.slice(0, Math.max(0, operationKeys.length - 1000))) delete state.operations[stale];
      return response;
    });
    return { ...result, idempotentReplay: false };
  }

  upsert(params) {
    plainObject(params, "params");
    const normalized = normalizeMission(params.mission);
    const expected = requestedRevision(params.expectedRevision);
    return this.#withIdempotency("missions.upsert", params, "mission.upserted", { missionId: normalized.manifest.id, policyHash: normalized.policyHash }, (state, timestamp) => {
      const existing = state.missions[normalized.manifest.id];
      if (expected !== undefined && existing?.revision !== expected) fail("REVISION_CONFLICT", "Mission revision changed; refresh before updating.");
      if (!existing && expected !== undefined) fail("REVISION_CONFLICT", "Mission does not exist at the expected revision.");
      if (existing && normalized.manifest.revision <= existing.manifest.revision) fail("REVISION_CONFLICT", "Authored mission revision must increase.");
      const record = {
        id: normalized.manifest.id,
        revision: (existing?.revision ?? 0) + 1,
        status: "draft",
        phase: "observe",
        manifest: normalized.manifest,
        manifestHash: normalized.manifestHash,
        policyHash: normalized.policyHash,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        checkpoint: undefined,
      };
      state.missions[record.id] = record;
      return { mission: publicRecord(record) };
    });
  }

  #assertActivatable(record) {
    const normalized = normalizeMission(record.manifest);
    if (normalized.manifestHash !== record.manifestHash || normalized.policyHash !== record.policyHash) fail("MISSION_HASH_MISMATCH", "Stored mission policy does not verify.");
    if (record.manifest.mode === "bounded" && !this.healthy) fail("GOVERNOR_UNHEALTHY", "Bounded mode cannot activate until every Gateway enforcement boundary is healthy.");
    if (record.manifest.mode === "bounded" && !record.manifest.timeWindow) fail("INVALID_MISSION", "Bounded mode requires an enforced timeWindow.");
    if (record.manifest.mode === "bounded" && record.manifest.tools.some((tool) => tool.name.includes("*"))) fail("INVALID_MISSION", "Bounded mode requires exact tool names.");
  }

  #transition(params, action) {
    plainObject(params, "params");
    const id = boundedString(params.id, "id", { max: 80, pattern: /^[a-z][a-z0-9-]*$/ });
    const expected = requestedRevision(params.expectedRevision);
    return this.#withIdempotency(`missions.${action}`, params, `mission.${action}d`, { missionId: id }, (state, timestamp) => {
      const record = state.missions[id];
      if (!record) fail("NOT_FOUND", "Mission was not found.");
      if (expected !== undefined && record.revision !== expected) fail("REVISION_CONFLICT", "Mission revision changed; refresh before updating.");
      if (action === "activate") {
        if (record.status !== "draft") fail("STATE_CONFLICT", "Only a reviewed draft can be explicitly activated.");
        this.#assertActivatable(record);
        record.status = "active";
        record.activatedAt = timestamp;
        record.pausedAt = undefined;
      } else if (action === "pause") {
        if (record.status !== "active") fail("STATE_CONFLICT", "Only an active mission can be paused.");
        record.status = "paused";
        record.pausedAt = timestamp;
      } else if (action === "resume") {
        if (record.status !== "paused") fail("STATE_CONFLICT", "Only a paused mission can be resumed.");
        this.#assertActivatable(record);
        record.status = "active";
        record.pausedAt = undefined;
      }
      record.revision += 1;
      record.updatedAt = timestamp;
      return { mission: publicRecord(record) };
    });
  }

  activate(params) { return this.#transition(params, "activate"); }
  pauseMission(params) { return this.#transition(params, "pause"); }
  resumeMission(params) { return this.#transition(params, "resume"); }

  setGlobalPaused(paused, params) {
    plainObject(params, "params");
    const reason = boundedString(params.reason, "reason", { max: 500 });
    return this.#withIdempotency(paused ? "global.pause" : "global.resume", params, paused ? "governor.paused" : "governor.resumed", { reasonHash: sha256(reason) }, (state, timestamp) => {
      state.globalPaused = paused;
      state.globalPauseReason = paused ? reason : undefined;
      state.globalPauseUpdatedAt = timestamp;
      return { globalPaused: paused, stateRevision: state.revision + 1 };
    });
  }

  advance(params) {
    plainObject(params, "params");
    const id = boundedString(params.id, "id", { max: 80, pattern: /^[a-z][a-z0-9-]*$/ });
    const phase = boundedString(params.phase, "phase", { max: 20 });
    if (!PHASES.includes(phase)) fail("INVALID_PARAMS", "phase is not a supported mission phase.");
    const expected = requestedRevision(params.expectedRevision);
    const evidence = evidenceArray(params.evidence);
    const runId = params.runId === undefined ? undefined : boundedString(params.runId, "runId", { max: 200, pattern: /^[A-Za-z0-9._:-]+$/ });
    return this.#withIdempotency("missions.advance", params, "mission.advanced", { missionId: id, phase, evidenceHash: sha256(evidence), evidenceCount: evidence.length }, (state, timestamp) => {
      const record = state.missions[id];
      if (!record) fail("NOT_FOUND", "Mission was not found.");
      if (record.status !== "active") fail("STATE_CONFLICT", "Only an active mission can advance.");
      if (expected !== undefined && record.revision !== expected) fail("REVISION_CONFLICT", "Mission revision changed; refresh before advancing.");
      if (!PHASE_TRANSITIONS[record.phase]?.has(phase)) fail("STATE_CONFLICT", `Mission cannot advance from ${record.phase} to ${phase}.`);
      if (phase === "complete" && record.manifest.completion.evidenceRequired && evidence.length === 0) fail("EVIDENCE_REQUIRED", "Completion requires evidence.");
      if (phase === "execute" && !runId) fail("RUN_BINDING_REQUIRED", "Execute phase requires a runId binding.");
      if (runId) {
        const binding = state.runs[runId];
        if (!binding || binding.missionId !== id) fail("RUN_BINDING_REQUIRED", "runId is not bound to this mission by before_agent_run.");
      }
      record.phase = phase;
      record.revision += 1;
      record.updatedAt = timestamp;
      record.checkpoint = { phase, runId, evidence, evidenceCount: evidence.length, evidenceHash: sha256(evidence), updatedAt: timestamp };
      return { mission: publicRecord(record) };
    });
  }

  #resolveByContext(state, context, { requireRunBinding = false } = {}) {
    const runId = context.runId;
    if (runId && state.runs[runId]) {
      const binding = state.runs[runId];
      if (requireRunBinding && binding.status !== "running") return { error: "Mission run is no longer active." };
      const record = state.missions[binding.missionId];
      if (!record) return { error: "Run is bound to an unknown mission." };
      return { record, binding };
    }
    const candidates = Object.values(state.missions)
      .map((record) => ({ record, score: selectorScore(record, context) }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score);
    if (candidates.length === 0) return {};
    if (candidates.length > 1 && candidates[0].score === candidates[1].score) return { error: "Mission binding is ambiguous." };
    if (requireRunBinding) return { record: candidates[0].record, error: "Mission execution is not bound by before_agent_run." };
    return { record: candidates[0].record };
  }

  #baseDecision(record, { sideEffect = false } = {}) {
    const state = this.store.snapshot();
    if (!this.healthy) return { outcome: "block", reason: "Autonomy governor is unhealthy.", category: "governor_unhealthy", sideEffect };
    if (state.globalPaused) return { outcome: "block", reason: "Autonomy is globally paused.", category: "global_pause", sideEffect };
    if (!record) return { outcome: "block", reason: "Mission is unknown.", category: "unknown_mission", sideEffect };
    if (record.status !== "active") return { outcome: "block", reason: "Mission is not active.", category: "mission_inactive", sideEffect };
    try {
      this.#assertActivatable(record);
    } catch (error) {
      return { outcome: "block", reason: "Mission policy failed integrity validation.", category: "invalid_policy", sideEffect };
    }
    if (!localWindowState(record.manifest.timeWindow, this.now()).allowed) {
      return { outcome: "block", reason: "Action is outside the Mission time window.", category: "time_window", sideEffect };
    }
    return { outcome: "allow", reason: "Mission policy permits this action.", category: "allowed", sideEffect };
  }

  evaluate(params) {
    plainObject(params, "params");
    this.store.assertHealthy();
    const id = boundedString(params.missionId, "missionId", { max: 80, pattern: /^[a-z][a-z0-9-]*$/ });
    const action = plainObject(params.action, "action");
    const record = this.store.snapshot().missions[id];
    if (!record) fail("NOT_FOUND", "Mission was not found.");
    let decision;
    if (action.kind === "agent_run") {
      decision = this.#baseDecision(record);
      if (decision.outcome === "allow" && record.manifest.mode === "bounded" && !action.runId) decision = { outcome: "block", reason: "Bounded run requires a runId.", category: "run_binding_required", sideEffect: false };
    } else if (action.kind === "tool_call") {
      const rule = record.manifest.tools.find((tool) => tool.name === action.toolName);
      decision = this.#baseDecision(record, { sideEffect: rule ? rule.effect !== "read" : true });
      if (decision.outcome === "allow" && (!rule || rule.decision === "deny")) decision = { outcome: "block", reason: rule ? "Tool is denied." : "Unknown tool is denied.", category: rule ? "tool_denied" : "unknown_tool", sideEffect: true };
      if (decision.outcome === "allow" && record.manifest.mode === "shadow" && rule.effect !== "read") decision = { outcome: "block", reason: "Shadow mode never permits side effects.", category: "shadow_side_effect", sideEffect: true };
      if (decision.outcome === "allow" && record.manifest.mode === "suggest" && rule.effect !== "read") decision = { outcome: "approval", reason: "Suggest mode requires explicit approval.", category: "approval_required", sideEffect: true };
    } else if (action.kind === "message_send") {
      decision = this.#baseDecision(record, { sideEffect: true });
      if (decision.outcome === "allow" && record.manifest.mode !== "bounded") decision = { outcome: "block", reason: `${record.manifest.mode} mode never sends outbound messages.`, category: `${record.manifest.mode}_side_effect`, sideEffect: true };
      const channel = String(action.channel ?? "").toLowerCase();
      if (decision.outcome === "allow" && (!record.manifest.outbound.channels.includes(channel) || !record.manifest.outbound.targets.includes(String(action.to ?? "")))) decision = { outcome: "block", reason: "Outbound destination is outside mission policy.", category: "outbound_denied", sideEffect: true };
    } else if (action.kind === "lifecycle") {
      const transition = action.transition;
      if (!["activate", "pause", "resume"].includes(transition)) fail("INVALID_PARAMS", "lifecycle transition must be activate, pause, or resume.");
      if (transition === "activate") {
        if (record.status !== "draft") {
          decision = { outcome: "block", reason: "Only a reviewed draft can be activated.", category: "state_conflict", sideEffect: false };
        } else {
          try {
            this.#assertActivatable(record);
            decision = { outcome: "allow", reason: "Mission is valid and ready for explicit activation.", category: "lifecycle_ready", sideEffect: false };
          } catch (error) {
            decision = { outcome: "block", reason: error instanceof Error ? error.message : "Mission cannot activate.", category: "activation_invalid", sideEffect: false };
          }
        }
      } else if (transition === "pause") {
        decision = record.status === "active"
          ? { outcome: "allow", reason: "Active mission can be paused.", category: "lifecycle_ready", sideEffect: false }
          : { outcome: "block", reason: "Only an active mission can be paused.", category: "state_conflict", sideEffect: false };
      } else if (record.status !== "paused") {
        decision = { outcome: "block", reason: "Only a paused mission can be resumed.", category: "state_conflict", sideEffect: false };
      } else {
        try {
          this.#assertActivatable(record);
          decision = { outcome: "allow", reason: "Mission remains valid and can be resumed.", category: "lifecycle_ready", sideEffect: false };
        } catch (error) {
          decision = { outcome: "block", reason: error instanceof Error ? error.message : "Mission cannot resume.", category: "activation_invalid", sideEffect: false };
        }
      }
    } else {
      fail("INVALID_PARAMS", "action.kind must be agent_run, tool_call, message_send, or lifecycle.");
    }
    return { missionId: id, policyHash: record.policyHash, decision: compatibleDecision(decision), idempotentReplay: false };
  }

  #recordDecision(type, record, decision, extra = {}) {
    if (!this.store.healthy) return;
    this.store.transact(type, { missionId: record?.id, outcome: decision.outcome, category: decision.category, ...extra }, () => undefined);
  }

  beforeAgentRun(event, context) {
    const channel = String(context?.channelId ?? event?.channelId ?? event?.channel ?? "").toLowerCase();
    const taggedMission = event?.metadata?.autonomyMissionId ?? context?.metadata?.autonomyMissionId;
    // Ordinary iMessage/SMS user turns are not Mission work. Never require a
    // contract, run binding, or global autonomy resume for a normal reply.
    if (isOrdinaryInteractiveChannel(channel) && !taggedMission) return { outcome: "pass" };
    const state = this.store.snapshot();
    const resolved = this.#resolveByContext(state, context);
    if (!resolved.record) {
      // Interactive chats and Gateway cron/heartbeat stay on the recipient
      // guard. A Mission contract is an optional overlay, not a prerequisite.
      if (resolved.error) {
        return { outcome: "block", reason: resolved.error, message: "Rico autonomy blocked this run because no healthy, explicit Mission contract was bound.", category: "ambiguous_mission" };
      }
      return { outcome: "pass" };
    }
    const decision = this.#baseDecision(resolved.record);
    if (decision.outcome === "block") {
      this.#recordDecision("run.blocked", resolved.record, decision);
      return { outcome: "block", reason: decision.reason, message: "Rico autonomy blocked this run under the active Mission policy.", category: decision.category };
    }
    const runId = context.runId;
    if (!runId) {
      const missing = { outcome: "block", reason: "Mission run lacks a host runId.", category: "run_binding_required" };
      this.#recordDecision("run.blocked", resolved.record, missing);
      return { outcome: "block", reason: missing.reason, message: "Rico autonomy requires a durable run binding before execution.", category: missing.category };
    }
    const intentKey = `run:${runId}`;
    if (state.intents[intentKey]) {
      return { outcome: "block", reason: "Duplicate mission run intent.", message: "Duplicate autonomous run suppressed.", category: "duplicate_intent" };
    }
    const counter = counterEntry(state, resolved.record.id, this.now());
    const budgetError = checkBudget(counter, resolved.record.manifest.budgets, "run", runId);
    if (budgetError) {
      const blocked = { outcome: "block", reason: budgetError, category: "budget_exhausted" };
      this.#recordDecision("run.blocked", resolved.record, blocked);
      return { outcome: "block", reason: budgetError, message: "Rico autonomy reached this Mission's run budget.", category: "budget_exhausted" };
    }
    const fingerprint = sha256({ missionId: resolved.record.id, runId, sessionKey: context.sessionKey, jobId: context.jobId });
    this.store.transact("run.bound", { missionId: resolved.record.id, runIdHash: sha256(runId), mode: resolved.record.manifest.mode }, (next) => {
      const liveCounter = counterEntry(next, resolved.record.id, this.now());
      const error = checkBudget(liveCounter, resolved.record.manifest.budgets, "run", runId);
      if (error) fail("BUDGET_EXHAUSTED", error);
      liveCounter.runs += 1;
      next.runs[runId] = { missionId: resolved.record.id, runId, sessionKey: context.sessionKey, jobId: context.jobId, startedAt: this.now(), status: "running" };
      next.intents[intentKey] = { key: intentKey, kind: "run", missionId: resolved.record.id, fingerprint, status: "reserved", createdAt: this.now() };
    });
    return { outcome: "pass" };
  }

  agentEnd(event, context) {
    if (!this.store.healthy) return;
    const runId = event.runId ?? context.runId;
    if (!runId) return;
    const binding = this.store.snapshot().runs[runId];
    if (!binding || ["succeeded", "failed"].includes(binding.status)) return;
    const intentKey = `run:${runId}`;
    this.store.transact("run.ended", {
      missionId: binding.missionId,
      runIdHash: sha256(runId),
      success: event.success === true,
      durationMs: Number.isFinite(event.durationMs) ? Math.max(0, Math.round(event.durationMs)) : undefined,
      errorHash: event.error ? sha256(event.error) : undefined,
    }, (state) => {
      const live = state.runs[runId];
      if (live) {
        live.status = event.success === true ? "succeeded" : "failed";
        live.endedAt = this.now();
        live.durationMs = Number.isFinite(event.durationMs) ? Math.max(0, Math.round(event.durationMs)) : undefined;
      }
      if (state.intents[intentKey]) {
        state.intents[intentKey].status = event.success === true ? "completed" : "failed";
        state.intents[intentKey].completedAt = this.now();
      }
    });
  }

  #toolIntentKey(event, context) {
    if (!context.runId || !event.toolCallId) return undefined;
    return `tool:${context.runId}:${event.toolCallId}`;
  }

  beforeToolCall(event, context) {
    const state = this.store.snapshot();
    const resolved = this.#resolveByContext(state, context, { requireRunBinding: true });
    if (!resolved.record) {
      if (resolved.error) return { block: true, blockReason: resolved.error };
      return;
    }
    const record = resolved.record;
    const base = this.#baseDecision(record, { sideEffect: true });
    if (base.outcome === "block" || resolved.error) {
      this.#recordDecision("tool.blocked", record, { ...base, category: resolved.error ? "run_binding_required" : base.category }, { toolName: event.toolName });
      return { block: true, blockReason: resolved.error ?? base.reason };
    }
    const binding = state.runs[context.runId];
    if (!binding || binding.missionId !== record.id || binding.status !== "running") return { block: true, blockReason: "Tool call is not bound to an active Mission run." };
    if (this.now() - binding.startedAt > record.manifest.budgets.runtimeSecondsPerRun * 1000) {
      this.#recordDecision("tool.blocked", record, { outcome: "block", category: "runtime_budget", reason: "Runtime budget exhausted." }, { toolName: event.toolName });
      return { block: true, blockReason: "Mission runtime budget exhausted." };
    }
    const rule = record.manifest.tools.find((tool) => tool.name === event.toolName);
    if (!rule || rule.decision === "deny") {
      const category = rule ? "tool_denied" : "unknown_tool";
      this.#recordDecision("tool.blocked", record, { outcome: "block", category, reason: "Tool is outside mission policy." }, { toolName: event.toolName });
      return { block: true, blockReason: rule ? "Tool is explicitly denied by Mission policy." : "Unknown tools are denied by Mission policy." };
    }
    if (record.manifest.mode === "shadow" && rule.effect !== "read") {
      this.#recordDecision("tool.blocked", record, { outcome: "block", category: "shadow_side_effect", reason: "Shadow mode blocks side effects." }, { toolName: event.toolName });
      return { block: true, blockReason: "Shadow mode never permits side effects." };
    }
    const intentKey = this.#toolIntentKey(event, context);
    if (!intentKey) return { block: true, blockReason: "Mission tool calls require runId and toolCallId idempotency bindings." };
    const fingerprint = sha256({ missionId: record.id, toolName: event.toolName, params: event.params, runId: context.runId, toolCallId: event.toolCallId });
    const existing = state.intents[intentKey];
    if (existing) return { block: true, blockReason: existing.fingerprint === fingerprint ? "Duplicate tool intent suppressed." : "Tool idempotency collision blocked." };
    const counter = counterEntry(state, record.id, this.now());
    const toolBudget = checkBudget(counter, record.manifest.budgets, "tool", context.runId);
    const writeBudget = rule.effect === "read" ? undefined : checkBudget(counter, record.manifest.budgets, "write", context.runId);
    if (toolBudget || writeBudget) return { block: true, blockReason: toolBudget ?? writeBudget };
    this.store.transact("tool.intent.reserved", { missionId: record.id, intentHash: sha256(intentKey), toolName: event.toolName, effect: rule.effect }, (next) => {
      const live = counterEntry(next, record.id, this.now());
      const error = checkBudget(live, record.manifest.budgets, "tool", context.runId) ?? (rule.effect === "read" ? undefined : checkBudget(live, record.manifest.budgets, "write", context.runId));
      if (error) fail("BUDGET_EXHAUSTED", error);
      live.toolCalls += 1;
      live.byRun[context.runId] = (live.byRun[context.runId] ?? 0) + 1;
      if (rule.effect !== "read") live.writeCalls += 1;
      next.intents[intentKey] = { key: intentKey, kind: "tool", missionId: record.id, runId: context.runId, toolCallId: event.toolCallId, toolName: event.toolName, effect: rule.effect, fingerprint, status: record.manifest.mode === "suggest" && rule.effect !== "read" ? "approval-pending" : "reserved", createdAt: this.now() };
    });
    if (record.manifest.mode === "suggest" && rule.effect !== "read") {
      return {
        requireApproval: {
          title: `Mission ${record.id}: ${event.toolName}`,
          description: "Allow this one bounded side effect proposed by Rico?",
          severity: rule.effect === "external" ? "critical" : "warning",
          timeoutMs: 60_000,
          timeoutBehavior: "deny",
          allowedDecisions: ["allow-once", "deny"],
          pluginId: "rico-autonomy-governor",
          onResolution: (resolution) => this.resolveIntent(intentKey, resolution),
        },
      };
    }
    return;
  }

  resolveIntent(intentKey, resolution) {
    if (!this.store.healthy) return;
    const current = this.store.snapshot().intents[intentKey];
    if (!current || current.status !== "approval-pending") return;
    const status = resolution === "allow-once" ? "authorized" : "denied";
    this.store.transact("tool.intent.resolved", { missionId: current.missionId, intentHash: sha256(intentKey), resolution: status }, (state) => {
      if (state.intents[intentKey]?.status === "approval-pending") {
        state.intents[intentKey].status = status;
        state.intents[intentKey].resolvedAt = this.now();
      }
    });
  }

  afterToolCall(event, context) {
    if (!this.store.healthy) return;
    const intentKey = this.#toolIntentKey(event, context);
    if (!intentKey) return;
    const intent = this.store.snapshot().intents[intentKey];
    if (!intent || ["completed", "failed", "denied"].includes(intent.status)) return;
    this.store.transact("tool.intent.completed", { missionId: intent.missionId, intentHash: sha256(intentKey), success: !event.error }, (state) => {
      if (state.intents[intentKey]) {
        state.intents[intentKey].status = event.error ? "failed" : "completed";
        state.intents[intentKey].completedAt = this.now();
      }
    });
  }

  #resolveOutbound(state, event, context) {
    if (context.runId && state.runs[context.runId]) return this.#resolveByContext(state, context, { requireRunBinding: true });
    const taggedMission = event.metadata?.autonomyMissionId;
    const taggedRun = event.metadata?.autonomyRunId;
    if (typeof taggedRun === "string" && state.runs[taggedRun]) {
      const binding = state.runs[taggedRun];
      if (taggedMission && taggedMission !== binding.missionId) return { error: "Outbound mission tag conflicts with its run binding." };
      if (binding.status !== "running") return { error: "Outbound run binding is no longer active." };
      const record = state.missions[binding.missionId];
      if (!record || (context.sessionKey && binding.sessionKey !== context.sessionKey)) return { error: "Outbound run binding is invalid." };
      return { record, binding };
    }
    if (!context.sessionKey) return taggedMission ? { error: "Outbound mission tag lacks a run binding." } : {};
    const bindings = Object.values(state.runs).filter((binding) => binding.sessionKey === context.sessionKey && binding.status === "running");
    const missionIds = [...new Set(bindings.map((binding) => binding.missionId))];
    if (missionIds.length > 1) return { error: "Outbound session has ambiguous mission bindings." };
    if (missionIds.length === 1) return { record: state.missions[missionIds[0]], binding: bindings.sort((a, b) => b.startedAt - a.startedAt)[0] };
    return this.#resolveByContext(state, context, { requireRunBinding: true });
  }

  messageSending(event, context) {
    const channel = String(context?.channelId ?? event?.channelId ?? event?.channel ?? "").toLowerCase();
    if (isOrdinaryInteractiveChannel(channel) && !event.metadata?.autonomyMissionId && !event.metadata?.autonomyRunId) return;
    const state = this.store.snapshot();
    const resolved = this.#resolveOutbound(state, event, context);
    if (!resolved.record) {
      if (resolved.error || event.metadata?.autonomyMissionId || event.metadata?.autonomyRunId) return { cancel: true, cancelReason: resolved.error ?? "Mission-bound outbound message has no run binding." };
      return;
    }
    const record = resolved.record;
    const base = this.#baseDecision(record, { sideEffect: true });
    if (base.outcome === "block" || resolved.error) return { cancel: true, cancelReason: resolved.error ?? base.reason };
    if (!resolved.binding || resolved.binding.missionId !== record.id || resolved.binding.status !== "running") return { cancel: true, cancelReason: "Outbound message is not bound to an active Mission run." };
    if (record.manifest.mode !== "bounded") {
      this.#recordDecision("outbound.blocked", record, { outcome: "block", category: `${record.manifest.mode}_side_effect`, reason: "Mode blocks outbound delivery." }, { channel: context.channelId });
      return { cancel: true, cancelReason: `${record.manifest.mode} mode never permits outbound delivery.` };
    }
    const destination = String(context.channelId ?? "").toLowerCase();
    if (!record.manifest.outbound.channels.includes(destination) || !record.manifest.outbound.targets.includes(String(event.to))) {
      this.#recordDecision("outbound.blocked", record, { outcome: "block", category: "outbound_denied", reason: "Destination denied." }, { channel: destination, targetHash: sha256(String(event.to)) });
      return { cancel: true, cancelReason: "Outbound destination is outside Mission policy." };
    }
    const rawKey = event.metadata?.idempotencyKey ?? context.messageId;
    if (typeof rawKey !== "string" || rawKey.length < 8) return { cancel: true, cancelReason: "Mission outbound delivery requires an idempotency key." };
    const intentKey = `outbound:${rawKey}`;
    const fingerprint = sha256({ missionId: record.id, channel: destination, to: event.to, content: event.content, threadId: event.threadId });
    const existing = state.intents[intentKey];
    if (existing) return { cancel: true, cancelReason: existing.fingerprint === fingerprint ? "Duplicate outbound intent suppressed." : "Outbound idempotency collision blocked." };
    const counter = counterEntry(state, record.id, this.now());
    const budgetError = checkBudget(counter, record.manifest.budgets, "outbound", resolved.binding.runId);
    if (budgetError) return { cancel: true, cancelReason: budgetError };
    this.store.transact("outbound.intent.reserved", { missionId: record.id, intentHash: sha256(intentKey), channel, targetHash: sha256(String(event.to)), contentHash: sha256(event.content) }, (next) => {
      const live = counterEntry(next, record.id, this.now());
      const error = checkBudget(live, record.manifest.budgets, "outbound", resolved.binding.runId);
      if (error) fail("BUDGET_EXHAUSTED", error);
      live.outbound += 1;
      next.intents[intentKey] = { key: intentKey, kind: "outbound", missionId: record.id, runId: resolved.binding.runId, fingerprint, status: "reserved", createdAt: this.now() };
    });
    return;
  }

  messageSent(event, context) {
    if (!this.store.healthy) return;
    const rawKey = event.metadata?.idempotencyKey ?? context.messageId;
    if (typeof rawKey !== "string") return;
    const intentKey = `outbound:${rawKey}`;
    const intent = this.store.snapshot().intents[intentKey];
    if (!intent || ["completed", "failed"].includes(intent.status)) return;
    this.store.transact("outbound.intent.completed", { missionId: intent.missionId, intentHash: sha256(intentKey), success: event.success === true }, (state) => {
      if (state.intents[intentKey]) {
        state.intents[intentKey].status = event.success === true ? "completed" : "failed";
        state.intents[intentKey].completedAt = this.now();
      }
    });
  }
}

export function errorEnvelope(error) {
  if (error instanceof GovernorError || error instanceof StoreError) return { code: error.code, message: error.message };
  return { code: "INTERNAL", message: "Autonomy governor request failed." };
}

export function requestFingerprint(value) {
  return sha256(canonicalStringify(value));
}
