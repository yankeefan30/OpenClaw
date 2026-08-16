#!/opt/homebrew/bin/node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";

const DEFAULT_REAL_IMSG = "/opt/homebrew/bin/imsg";
const DEFAULT_POLICY_PATH = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "OpenClaw Studio",
  "rico-owner-command-route.json",
);
const MAX_TRACKED_REQUESTS = 512;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const DEFAULT_OWNER_SELF_CHAT_ROUTE_TTL_MS = 5 * 60 * 1000;

export function normalizeHandle(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  for (const prefix of ["imessage:", "sms:", "tel:", "mailto:"]) {
    if (lower.startsWith(prefix)) return normalizeHandle(raw.slice(prefix.length));
  }
  if (raw.includes("@")) return lower;
  const digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+")) return digits ? `+${digits}` : "";
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits || lower;
}

export function isLiteralLeadingRicoMention(value) {
  return /^\s*@rico(?:\s|[:,.!?;\-]|$)/iu.test(String(value ?? ""));
}

function positiveChatId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function validateRoutePolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.schemaVersion !== 1 || value.enabled !== true) return null;
  if (!Array.isArray(value.ownerHandles) || !Array.isArray(value.allowedGroupChatIds)) return null;

  const ownerHandles = [...new Set(value.ownerHandles.map(normalizeHandle).filter(Boolean))];
  const allowedGroupChatIds = [
    ...new Set(value.allowedGroupChatIds.map(positiveChatId).filter((item) => item !== null)),
  ];
  if (ownerHandles.length !== 1 || allowedGroupChatIds.length === 0) return null;
  if (ownerHandles.length !== value.ownerHandles.length) return null;
  if (allowedGroupChatIds.length !== value.allowedGroupChatIds.length) return null;
  const notBeforeMs = Number(value.notBeforeMs);
  if (!Number.isFinite(notBeforeMs) || notBeforeMs <= 0) return null;

  return Object.freeze({
    schemaVersion: 1,
    enabled: true,
    ownerHandles: Object.freeze(ownerHandles),
    allowedGroupChatIds: Object.freeze(allowedGroupChatIds),
    notBeforeMs,
  });
}

function isPrivateFile(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) return false;
  if ((stat.mode & 0o777) !== 0o600) return false;
  return typeof process.getuid !== "function" || stat.uid === process.getuid();
}

function isPrivateDirectory(directoryPath) {
  const stat = fs.lstatSync(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  if ((stat.mode & 0o777) !== 0o700) return false;
  return typeof process.getuid !== "function" || stat.uid === process.getuid();
}

export function readRoutePolicy(policyPath = DEFAULT_POLICY_PATH) {
  try {
    const directory = path.dirname(policyPath);
    if (!isPrivateDirectory(directory) || !isPrivateFile(policyPath)) return null;
    return validateRoutePolicy(JSON.parse(fs.readFileSync(policyPath, "utf8")));
  } catch {
    return null;
  }
}

export function createRoutePolicyProvider(policyPath = DEFAULT_POLICY_PATH) {
  // Read the private policy for every candidate transport frame. Approvals,
  // revocations, pause and group changes therefore take effect without
  // restarting the long-lived imsg bridge. Any transient read/permission/
  // schema failure returns null and leaves from-me rows unpromoted.
  return () => readRoutePolicy(policyPath);
}

function messageTimestampMs(message) {
  for (const key of ["created_at", "createdAt", "message_ts", "timestamp", "date"]) {
    const raw = message?.[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw < 1e12 ? raw * 1000 : raw;
    if (typeof raw === "string" && raw.trim()) {
      const numeric = Number(raw);
      if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function activeRoutePolicy(policy) {
  return validateRoutePolicy(policy);
}

/**
 * A single-slot, process-local route hint. The reviewed policy permits exactly
 * one owner, so retaining more than one direct self-chat mapping would only
 * broaden the rewrite surface. The hint is never persisted and expires even
 * if the underlying Messages chat continues to exist.
 */
export function createOwnerSelfChatRouteCache({
  ttlMs = DEFAULT_OWNER_SELF_CHAT_ROUTE_TTL_MS,
  now = () => Date.now(),
} = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 60 * 60 * 1000) {
    throw new RangeError("owner self-chat route TTL must be between 1ms and 1 hour");
  }
  if (typeof now !== "function") throw new TypeError("owner self-chat route clock must be a function");

  let route = null;
  const clear = () => {
    route = null;
  };
  return Object.freeze({
    remember(ownerHandle, chatId, eventTimestampMs, observedAtMs = now()) {
      const owner = normalizeHandle(ownerHandle);
      const exactChatId = positiveChatId(chatId);
      if (
        !owner ||
        exactChatId === null ||
        !Number.isFinite(eventTimestampMs) ||
        !Number.isFinite(observedAtMs)
      ) {
        clear();
        return false;
      }
      route = Object.freeze({ owner, chatId: exactChatId, eventTimestampMs, observedAtMs });
      return true;
    },
    resolve(ownerHandle, notBeforeMs, resolvedAtMs = now()) {
      const owner = normalizeHandle(ownerHandle);
      if (!route || !owner || !Number.isFinite(notBeforeMs) || !Number.isFinite(resolvedAtMs)) {
        return null;
      }
      const ageMs = resolvedAtMs - route.observedAtMs;
      if (
        ageMs < 0 ||
        ageMs > ttlMs ||
        route.owner !== owner ||
        route.eventTimestampMs < notBeforeMs
      ) {
        clear();
        return null;
      }
      return route.chatId;
    },
    clear,
    get size() {
      return route === null ? 0 : 1;
    },
  });
}

/**
 * Remember only a live, direct owner self-chat notification. History results
 * deliberately do not call this function: an old database row is not evidence
 * that a new reply belongs in that chat.
 */
export function observeOwnerSelfChat(message, policy, routeCache, observedAtMs = Date.now()) {
  const activePolicy = activeRoutePolicy(policy);
  if (!activePolicy) {
    routeCache?.clear?.();
    return false;
  }
  if (!routeCache || typeof routeCache.remember !== "function") return false;
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  if (message.is_group !== false) return false;

  const chatId = positiveChatId(message.chat_id);
  if (chatId === null) return false;
  const owner = activePolicy.ownerHandles[0];
  const sender = normalizeHandle(message.sender);
  const destination = normalizeHandle(message.destination_caller_id);
  if (!sender || !destination || sender !== owner || destination !== owner) return false;

  const timestamp = messageTimestampMs(message);
  if (timestamp === null || timestamp < activePolicy.notBeforeMs) return false;
  return routeCache.remember(owner, chatId, timestamp, observedAtMs);
}

/**
 * Rewrite only the exact RPC shape OpenClaw uses for an iMessage handle send.
 * Existing chat targets, SMS/auto sends, other methods and unavailable route
 * evidence pass through untouched. Thread metadata is removed only for the
 * exact self-chat rewrite because the AppleScript self-chat path cannot safely
 * retry the historical threaded request.
 */
export function rewriteOwnerSelfChatSend(parsed, policy, routeCache, resolvedAtMs = Date.now()) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const activePolicy = activeRoutePolicy(policy);
  if (!activePolicy) {
    routeCache?.clear?.();
    return parsed;
  }
  if (parsed.method !== "send") return parsed;
  const params = parsed.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return parsed;
  if (params.service !== "imessage") return parsed;
  if (
    Object.hasOwn(params, "chat_id") ||
    Object.hasOwn(params, "chat_guid") ||
    Object.hasOwn(params, "chat_identifier")
  ) {
    return parsed;
  }

  const owner = activePolicy.ownerHandles[0];
  if (normalizeHandle(params.to) !== owner) return parsed;
  if (!routeCache || typeof routeCache.resolve !== "function") return parsed;
  const chatId = routeCache.resolve(owner, activePolicy.notBeforeMs, resolvedAtMs);
  if (chatId === null) return parsed;

  const rewrittenParams = { ...params, chat_id: chatId };
  delete rewrittenParams.to;
  delete rewrittenParams.reply_to;
  return { ...parsed, params: rewrittenParams };
}

export function promoteOwnerCommand(message, policy) {
  if (!policy || !message || typeof message !== "object" || Array.isArray(message)) return message;
  if (message.is_from_me !== true || message.is_group !== true) return message;
  if (!isLiteralLeadingRicoMention(message.text)) return message;

  const chatId = positiveChatId(message.chat_id);
  if (chatId === null || !policy.allowedGroupChatIds.includes(chatId)) return message;

  const sender = normalizeHandle(message.sender);
  const destination = normalizeHandle(message.destination_caller_id);
  if (!sender || !destination || sender !== destination) return message;
  if (!policy.ownerHandles.includes(sender)) return message;
  // imsg can replay backlog rows through either messages.history or the live
  // notification stream after a reconnect. Apply the activation fence to
  // every candidate frame so pre-approval commands are never promoted.
  const timestamp = messageTimestampMs(message);
  if (timestamp === null || timestamp < policy.notBeforeMs) return message;

  // This one-bit normalization enters OpenClaw's existing inbound path. The
  // original GUID, sender, destination, group and text remain unchanged, so
  // native allowlists, persistent dedupe and echo-cache checks still apply.
  return { ...message, is_from_me: false };
}

function transformHistoryResult(parsed, policy) {
  if (!parsed?.result || !Array.isArray(parsed.result.messages)) return parsed;
  let changed = false;
  const messages = parsed.result.messages.map((message) => {
    const promoted = promoteOwnerCommand(message, policy);
    if (promoted !== message) changed = true;
    return promoted;
  });
  return changed ? { ...parsed, result: { ...parsed.result, messages } } : parsed;
}

export function transformRpcFrame(parsed, requestMethods, policy, routeCache, observedAtMs = Date.now()) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  if (parsed.method === "message") {
    // imsg 0.14.1 wraps live notifications as params.message. Keep support
    // for the earlier direct params shape, but never flatten or rewrite the
    // surrounding transport envelope.
    if (parsed.params?.message && typeof parsed.params.message === "object") {
      observeOwnerSelfChat(parsed.params.message, policy, routeCache, observedAtMs);
      const message = promoteOwnerCommand(parsed.params.message, policy);
      return message === parsed.params.message
        ? parsed
        : { ...parsed, params: { ...parsed.params, message } };
    }
    observeOwnerSelfChat(parsed.params, policy, routeCache, observedAtMs);
    const params = promoteOwnerCommand(parsed.params, policy);
    return params === parsed.params ? parsed : { ...parsed, params };
  }
  if (parsed.id === undefined || parsed.id === null) return parsed;
  const key = String(parsed.id);
  const method = requestMethods.get(key);
  requestMethods.delete(key);
  return method === "messages.history" ? transformHistoryResult(parsed, policy) : parsed;
}

export function trackRpcRequest(parsed, requestMethods) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  if (parsed.id === undefined || parsed.id === null || typeof parsed.method !== "string") return;
  if (requestMethods.size >= MAX_TRACKED_REQUESTS) {
    const oldest = requestMethods.keys().next().value;
    if (oldest !== undefined) requestMethods.delete(oldest);
  }
  requestMethods.set(String(parsed.id), parsed.method);
}

export function transformRequestLine(
  line,
  requestMethods,
  policy,
  routeCache,
  resolvedAtMs = Date.now(),
) {
  try {
    const parsed = JSON.parse(line);
    trackRpcRequest(parsed, requestMethods);
    const rewritten = rewriteOwnerSelfChatSend(parsed, policy, routeCache, resolvedAtMs);
    return rewritten === parsed ? line : JSON.stringify(rewritten);
  } catch {
    // Never interfere with imsg input. Unknown frames are relayed unchanged.
    return line;
  }
}

export function transformResponseLine(
  line,
  requestMethods,
  policy,
  routeCache,
  observedAtMs = Date.now(),
) {
  try {
    const parsed = JSON.parse(line);
    const transformed = transformRpcFrame(parsed, requestMethods, policy, routeCache, observedAtMs);
    return transformed === parsed ? line : JSON.stringify(transformed);
  } catch {
    // Diagnostics and future protocol frames remain byte-for-byte text.
    return line;
  }
}

function writeWithBackpressure(stream, data, source) {
  if (stream.write(data)) return;
  source.pause();
  stream.once("drain", () => source.resume());
}

function main() {
  const args = process.argv.slice(2);
  const policyPath = process.env.RICO_OWNER_ROUTE_POLICY?.trim() || DEFAULT_POLICY_PATH;
  const currentPolicy = createRoutePolicyProvider(policyPath);
  if (!currentPolicy()) {
    process.stderr.write("imsg owner route disabled: private policy is unavailable or invalid\n");
  }

  const child = spawn(DEFAULT_REAL_IMSG, args, { stdio: ["pipe", "pipe", "pipe"] });
  const requestMethods = new Map();
  const ownerSelfChatRoutes = createOwnerSelfChatRouteCache();
  let stdinBuffer = "";
  let stdinOversizedFrame = false;
  const stdinDecoder = new StringDecoder("utf8");
  const emitRequestLine = (line, trailingNewline = true) => {
    const output = transformRequestLine(
      line,
      requestMethods,
      currentPolicy(),
      ownerSelfChatRoutes,
    );
    writeWithBackpressure(child.stdin, `${output}${trailingNewline ? "\n" : ""}`, process.stdin);
  };
  process.stdin.on("data", (chunk) => {
    stdinBuffer += stdinDecoder.write(chunk);
    let newline = stdinBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = stdinBuffer.slice(0, newline);
      if (stdinOversizedFrame || Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
        writeWithBackpressure(child.stdin, `${line}\n`, process.stdin);
      } else {
        emitRequestLine(line);
      }
      stdinOversizedFrame = false;
      stdinBuffer = stdinBuffer.slice(newline + 1);
      newline = stdinBuffer.indexOf("\n");
    }
    if (stdinOversizedFrame && stdinBuffer) {
      writeWithBackpressure(child.stdin, stdinBuffer, process.stdin);
      stdinBuffer = "";
    } else if (Buffer.byteLength(stdinBuffer, "utf8") > MAX_FRAME_BYTES) {
      // Oversized/unknown frames are never parsed or dropped. Flush this exact
      // decoded segment and pass through until its terminating newline.
      writeWithBackpressure(child.stdin, stdinBuffer, process.stdin);
      stdinBuffer = "";
      stdinOversizedFrame = true;
    }
  });
  process.stdin.on("end", () => {
    stdinBuffer += stdinDecoder.end();
    if (stdinBuffer) {
      if (stdinOversizedFrame || Buffer.byteLength(stdinBuffer, "utf8") > MAX_FRAME_BYTES) {
        writeWithBackpressure(child.stdin, stdinBuffer, process.stdin);
      } else {
        emitRequestLine(stdinBuffer, false);
      }
    }
    child.stdin.end();
  });

  let stdoutBuffer = "";
  let stdoutOversizedFrame = false;
  const stdoutDecoder = new StringDecoder("utf8");
  const emitLine = (line, trailingNewline = true) => {
    const output = transformResponseLine(
      line,
      requestMethods,
      currentPolicy(),
      ownerSelfChatRoutes,
    );
    writeWithBackpressure(process.stdout, `${output}${trailingNewline ? "\n" : ""}`, child.stdout);
  };
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += stdoutDecoder.write(chunk);
    let newline = stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = stdoutBuffer.slice(0, newline);
      if (stdoutOversizedFrame || Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
        writeWithBackpressure(process.stdout, `${line}\n`, child.stdout);
      } else {
        emitLine(line);
      }
      stdoutOversizedFrame = false;
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      newline = stdoutBuffer.indexOf("\n");
    }
    if (stdoutOversizedFrame && stdoutBuffer) {
      writeWithBackpressure(process.stdout, stdoutBuffer, child.stdout);
      stdoutBuffer = "";
    } else if (Buffer.byteLength(stdoutBuffer, "utf8") > MAX_FRAME_BYTES) {
      writeWithBackpressure(process.stdout, stdoutBuffer, child.stdout);
      stdoutBuffer = "";
      stdoutOversizedFrame = true;
    }
  });
  child.stdout.on("end", () => {
    stdoutBuffer += stdoutDecoder.end();
    if (stdoutBuffer) {
      if (stdoutOversizedFrame || Buffer.byteLength(stdoutBuffer, "utf8") > MAX_FRAME_BYTES) {
        writeWithBackpressure(process.stdout, stdoutBuffer, child.stdout);
      } else {
        emitLine(stdoutBuffer, false);
      }
    }
  });
  child.stderr.pipe(process.stderr);

  child.on("error", (error) => {
    process.stderr.write(`imsg owner route failed to start transport: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on("close", (code, terminatingSignal) => {
    if (terminatingSignal) {
      // Remove our forwarding listener before re-raising; otherwise the
      // process catches its own signal indefinitely and OpenClaw cannot stop
      // the long-lived transport cleanly.
      process.removeAllListeners(terminatingSignal);
      process.kill(process.pid, terminatingSignal);
    } else {
      process.exitCode = code ?? 1;
    }
  });
  for (const forwardingSignal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(forwardingSignal, () => {
      if (!child.killed) child.kill(forwardingSignal);
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
