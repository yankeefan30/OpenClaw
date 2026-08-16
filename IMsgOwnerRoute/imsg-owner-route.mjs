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
  const ownerDirectChatId = value.ownerDirectChatId == null
    ? null
    : positiveChatId(value.ownerDirectChatId);
  if (value.ownerDirectChatId != null && ownerDirectChatId === null) return null;

  return Object.freeze({
    schemaVersion: 1,
    enabled: true,
    ownerHandles: Object.freeze(ownerHandles),
    allowedGroupChatIds: Object.freeze(allowedGroupChatIds),
    notBeforeMs,
    ownerDirectChatId,
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

const OWNER_SEND_METHODS = new Set(["send", "send.rich"]);
const OWNER_SEND_SERVICES = new Set(["imessage", "auto"]);
const CLI_SEND_TIMEOUT_MS = 45_000;

function ownerSendService(value) {
  return String(value ?? "").trim().toLowerCase();
}

function isOwnerSendFrame(parsed) {
  if (!OWNER_SEND_METHODS.has(parsed.method)) return false;
  const params = parsed.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return false;
  const service = ownerSendService(params.service);
  return service === "" || OWNER_SEND_SERVICES.has(service);
}

/**
 * Rewrite the exact RPC shape OpenClaw uses for an owner iMessage send.
 * On this Mac, AppleScript delivery to chat_id 570 hangs even without
 * `reply_to`, while the same text sent to the owner handle returns a
 * receipt. Keep owner replies on that working handle, strip thread
 * metadata that AppleScript cannot resolve, and never use send.rich
 * (IMCore is unavailable while SIP is on).
 */
export function rewriteOwnerSelfChatSend(parsed, policy, routeCache, resolvedAtMs = Date.now()) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const activePolicy = activeRoutePolicy(policy);
  if (!activePolicy) {
    routeCache?.clear?.();
    return parsed;
  }
  if (!isOwnerSendFrame(parsed)) return parsed;
  const params = parsed.params;

  const owner = activePolicy.ownerHandles[0];
  const cachedChatId = (routeCache && typeof routeCache.resolve === "function"
    ? routeCache.resolve(owner, activePolicy.notBeforeMs, resolvedAtMs)
    : null) ?? activePolicy.ownerDirectChatId;
  if (Object.hasOwn(params, "chat_guid") || Object.hasOwn(params, "chat_identifier")) {
    return parsed;
  }
  const targetedChatId = positiveChatId(params.chat_id);
  let ownerTargeted = false;
  if (targetedChatId !== null) {
    if (cachedChatId !== targetedChatId) return parsed;
    ownerTargeted = true;
  } else if (normalizeHandle(params.to) === owner) {
    ownerTargeted = true;
  }
  if (!ownerTargeted) return parsed;

  const rewrittenParams = { ...params, to: owner };
  delete rewrittenParams.chat_id;
  delete rewrittenParams.reply_to;
  const method = parsed.method === "send.rich" ? "send" : parsed.method;
  const changed = method !== parsed.method ||
    rewrittenParams.chat_id !== params.chat_id ||
    rewrittenParams.to !== params.to ||
    Object.hasOwn(params, "reply_to");
  return changed ? { ...parsed, method, params: rewrittenParams } : parsed;
}

/**
 * Gateway's long-lived `imsg rpc` watcher never finishes its in-flight
 * chat.db poll, so RPC `send` sits behind it until the websocket times out.
 * A short-lived `imsg send` CLI process is the invocation that actually
 * delivers on this Mac (handle for owner self-chat, chat_id for groups).
 */
export function buildImsgCliSendArgs(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new TypeError("imsg CLI send requires params");
  }
  const args = ["send", "--json"];
  const text = String(params.text ?? "");
  if (text) args.push("--text", text);
  if (typeof params.file === "string" && params.file.trim()) {
    args.push("--file", params.file);
  }
  const chatId = positiveChatId(params.chat_id);
  if (chatId !== null) args.push("--chat-id", String(chatId));
  else if (typeof params.chat_guid === "string" && params.chat_guid.trim()) {
    args.push("--chat-guid", params.chat_guid);
  } else if (typeof params.chat_identifier === "string" && params.chat_identifier.trim()) {
    args.push("--chat-identifier", params.chat_identifier);
  } else if (params.to != null && String(params.to).trim()) {
    args.push("--to", String(params.to).trim());
  } else {
    throw new Error("imsg CLI send requires a target");
  }
  if (!text && !(typeof params.file === "string" && params.file.trim())) {
    throw new Error("imsg CLI send requires text or a file");
  }
  const service = ownerSendService(params.service);
  if (service && service !== "auto") args.push("--service", service);
  return args;
}

function isCliSendFrame(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  if (parsed.id === undefined || parsed.id === null) return false;
  if (!OWNER_SEND_METHODS.has(parsed.method)) return false;
  return Boolean(parsed.params && typeof parsed.params === "object" && !Array.isArray(parsed.params));
}

export function rpcResultFromImsgCliSend(parsed) {
  const raw = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const id = raw.message_id ?? raw.messageId ?? raw.guid ?? raw.id;
  const messageId = typeof id === "string" && id.trim()
    ? id.trim()
    : typeof id === "number" && Number.isFinite(id)
      ? String(id)
      : undefined;
  return {
    ok: raw.ok !== false && raw.status !== "error",
    status: raw.status ?? "sent",
    transport: raw.transport ?? "applescript",
    ...messageId ? { messageId, message_id: messageId, guid: messageId } : {},
  };
}

function runImsgCliSend(params, timeoutMs = CLI_SEND_TIMEOUT_MS) {
  const args = buildImsgCliSendArgs(params);
  return new Promise((resolve, reject) => {
    const child = spawn(DEFAULT_REAL_IMSG, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`imsg CLI send timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `imsg CLI send exited ${code}`));
        return;
      }
      const trimmed = stdout.trim();
      try {
        const parsed = trimmed ? JSON.parse(trimmed) : { status: "sent" };
        resolve(rpcResultFromImsgCliSend(parsed));
      } catch {
        resolve({ ok: true, status: "sent", transport: "applescript" });
      }
    });
  });
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
    if (output !== line) {
      try {
        const originalChatId = JSON.parse(line)?.params?.chat_id;
        const handle = JSON.parse(output)?.params?.to;
        process.stderr.write(
          originalChatId != null && handle
            ? `imsg owner route: rewrote owner send away from chat_id=${originalChatId} onto ${handle}\n`
            : handle
              ? `imsg owner route: stripped owner send thread metadata; keeping ${handle}\n`
              : "imsg owner route: stripped owner send thread metadata\n",
        );
      } catch {
        process.stderr.write("imsg owner route: rewrote owner send\n");
      }
    }
    try {
      const parsed = JSON.parse(output);
      if (isCliSendFrame(parsed)) {
        requestMethods.delete(String(parsed.id));
        void fulfillSendViaCli(parsed);
        return;
      }
    } catch {
      // Non-JSON frames stay on the long-lived rpc transport.
    }
    writeWithBackpressure(child.stdin, `${output}${trailingNewline ? "\n" : ""}`, process.stdin);
  };
  const fulfillSendViaCli = async (parsed) => {
    try {
      process.stderr.write("imsg owner route: delivering send via short-lived imsg CLI\n");
      const result = await runImsgCliSend(parsed.params);
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result })}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`imsg owner route: CLI send failed: ${message}\n`);
      process.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: parsed.id,
        error: { code: -32000, message },
      })}\n`);
    }
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
