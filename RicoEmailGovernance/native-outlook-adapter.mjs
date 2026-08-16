import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OUTLOOK_BUNDLE_ID,
  OUTLOOK_CLIENT,
} from "./definition.mjs";
import {
  createPrivateJsonExclusive,
  ensurePrivateDirectory,
  readPrivateJson,
  writePrivateJson,
} from "./private-store.mjs";
import {
  normalizeEmail,
  RicoEmailPolicyError,
  sha256,
} from "./policy.mjs";

const DEFAULT_OUTLOOK_PATH = "/Applications/Microsoft Outlook.app";
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/u;

export function defaultNativeOutlookClaimDirectory(homeDirectory = os.homedir()) {
  return path.join(
    path.resolve(homeDirectory),
    "Library",
    "Application Support",
    "OpenClaw Studio",
    "governance",
    "rico-email",
    "native-outlook-claims",
  );
}

/**
 * Mail-only adapter for the installed Microsoft Outlook Apple-event surface.
 * iMessage principal proof remains a separate Gateway responsibility.
 *
 * Sending is disabled unless the integration explicitly supplies
 * `sendEnabled: true`. Tests inject a runner and never invoke Outlook.
 */
export class NativeOutlookAdapter {
  constructor({
    runner = runOutlookAppleScript,
    appPath = DEFAULT_OUTLOOK_PATH,
    claimsDirectory = defaultNativeOutlookClaimDirectory(),
    sendEnabled = false,
    now = () => new Date(),
  } = {}) {
    if (typeof runner !== "function") throw coded("native_outlook_runner_invalid");
    this.runner = runner;
    this.appPath = path.resolve(appPath);
    this.claimsDirectory = ensurePrivateDirectory(path.resolve(claimsDirectory));
    this.sendEnabled = sendEnabled === true;
    this.now = now;
  }

  async health() {
    try {
      await assertInstalledOutlook(this.appPath);
      const result = await this.runner({ mode: "accounts", senderAccount: null });
      if (!result || result.ok !== true || result.bundleId !== OUTLOOK_BUNDLE_ID
          || !Array.isArray(result.accounts) || result.accounts.length < 1) {
        throw coded("native_outlook_account_probe_invalid");
      }
      const accounts = result.accounts.map(normalizeEmail);
      if (accounts.some((item) => !item) || new Set(accounts).size !== accounts.length) {
        throw coded("native_outlook_accounts_ambiguous");
      }
      return Object.freeze({ ok: true, client: OUTLOOK_CLIENT, clientBundleId: OUTLOOK_BUNDLE_ID, sendEnabled: this.sendEnabled });
    } catch (error) {
      return Object.freeze({ ok: false, errorCode: safeErrorCode(error), sendEnabled: this.sendEnabled });
    }
  }

  async preflightEmailSend(request) {
    const envelope = validateEnvelope(request, { contentRequired: false });
    await assertInstalledOutlook(this.appPath);
    if (!this.sendEnabled) throw coded("native_outlook_send_disabled");
    const result = await this.runner({ mode: "account", senderAccount: envelope.from });
    if (!result || result.ok !== true || result.bundleId !== OUTLOOK_BUNDLE_ID
        || normalizeEmail(result.senderAccount) !== envelope.from || result.accountMatches !== 1
        || result.workingOffline === true || result.sendCapable !== true) {
      throw coded("native_outlook_source_account_unproven");
    }
    if (envelope.shape === "single") {
      return Object.freeze({
        ok: true,
        client: OUTLOOK_CLIENT,
        clientBundleId: OUTLOOK_BUNDLE_ID,
        senderAccount: envelope.from,
        recipient: envelope.to[0],
        outlookClientProven: true,
        sourceAccountProven: true,
        recipientProven: true,
        noSenderFallback: true,
        idempotentSends: true,
        attachmentsSupported: true,
      });
    }
    return Object.freeze({
      ok: true,
      client: OUTLOOK_CLIENT,
      clientBundleId: OUTLOOK_BUNDLE_ID,
      senderAccount: envelope.from,
      to: envelope.to,
      cc: envelope.cc,
      bcc: [],
      outlookClientProven: true,
      sourceAccountProven: true,
      recipientProven: true,
      noSenderFallback: true,
      idempotentSends: true,
      explicitRecipientsOnly: true,
      attachmentsSupported: true,
    });
  }

  async sendEmail(request) {
    const envelope = validateEnvelope(request, { contentRequired: true });
    if (!this.sendEnabled) throw coded("native_outlook_send_disabled");
    await assertInstalledOutlook(this.appPath);
    const idempotencyKey = String(request.idempotencyKey ?? "").trim();
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw coded("native_outlook_idempotency_key_invalid");
    if (request.requireSourceAccountProof !== true || request.noSenderFallback !== true) {
      throw coded("native_outlook_proof_requirements_missing");
    }
    const requestHash = sha256(JSON.stringify({
      from: envelope.from,
      to: envelope.to,
      cc: envelope.cc,
      subject: envelope.subject,
      text: envelope.text,
      attachments: envelope.attachments.map((item) => [item.path, item.sha256, item.byteSize]),
    }));
    const keyHash = sha256(idempotencyKey);
    const claimPath = path.join(this.claimsDirectory, `${keyHash}.json`);
    const claimed = createPrivateJsonExclusive(claimPath, {
      schema: "rico.native-outlook-send-claim",
      schemaVersion: 1,
      keyHash,
      requestHash,
      status: "reserved",
      reservedAt: this.timestamp(),
      completedAt: null,
      providerMessageIdHash: null,
    });
    if (!claimed) {
      const existing = readPrivateJson(claimPath);
      if (existing?.requestHash !== requestHash) throw coded("native_outlook_idempotency_collision");
      throw coded("native_outlook_idempotency_claim_exists");
    }

    const result = await this.runner({
      mode: "send",
      senderAccount: envelope.from,
      to: envelope.to,
      cc: envelope.cc,
      subject: envelope.subject,
      text: envelope.text,
      attachments: envelope.attachments,
    });
    if (!result || result.ok !== true || result.bundleId !== OUTLOOK_BUNDLE_ID
        || normalizeEmail(result.senderAccount) !== envelope.from || result.accountMatches !== 1
        || String(result.outlookRecordId ?? "").trim() === "") {
      throw coded("native_outlook_send_unconfirmed");
    }
    assertExactRecipients(result.to, envelope.to, "native_outlook_send_to_mismatch");
    assertExactRecipients(result.cc, envelope.cc, "native_outlook_send_cc_mismatch");
    assertExactRecipients(result.bcc, [], "native_outlook_send_bcc_forbidden");
    const messageId = `outlook-native:${createHash("sha256").update(`${keyHash}\u0000${result.outlookRecordId}`, "utf8").digest("hex")}`;
    writePrivateJson(claimPath, {
      schema: "rico.native-outlook-send-claim",
      schemaVersion: 1,
      keyHash,
      requestHash,
      status: "confirmed",
      reservedAt: readPrivateJson(claimPath).reservedAt,
      completedAt: this.timestamp(),
      providerMessageIdHash: sha256(messageId),
    });
    if (envelope.shape === "single") {
      return Object.freeze({
        ok: true,
        client: OUTLOOK_CLIENT,
        clientBundleId: OUTLOOK_BUNDLE_ID,
        from: envelope.from,
        to: envelope.to[0],
        messageId,
        sourceAccountProven: true,
        noSenderFallback: true,
      });
    }
    return Object.freeze({
      ok: true,
      client: OUTLOOK_CLIENT,
      clientBundleId: OUTLOOK_BUNDLE_ID,
      from: envelope.from,
      to: envelope.to,
      cc: envelope.cc,
      bcc: [],
      messageId,
      sourceAccountProven: true,
      noSenderFallback: true,
      explicitRecipientsOnly: true,
    });
  }

  timestamp() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw coded("native_outlook_clock_invalid");
    return date.toISOString();
  }
}

export async function assertInstalledOutlook(appPath = DEFAULT_OUTLOOK_PATH) {
  const resolved = path.resolve(appPath);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw coded("native_outlook_app_invalid");
  const plist = path.join(resolved, "Contents", "Info.plist");
  const executable = path.join(resolved, "Contents", "MacOS", "Microsoft Outlook");
  const plistStat = fs.lstatSync(plist);
  const executableStat = fs.lstatSync(executable);
  if (!plistStat.isFile() || plistStat.isSymbolicLink() || !executableStat.isFile() || executableStat.isSymbolicLink()) {
    throw coded("native_outlook_app_invalid");
  }
  const bundleId = await readPlistValue(plist, "CFBundleIdentifier");
  if (bundleId !== OUTLOOK_BUNDLE_ID) throw coded("native_outlook_bundle_mismatch");
  return Object.freeze({ appPath: resolved, bundleId });
}

/**
 * Executes fixed-shape AppleScript over stdin. Message content and recipients
 * never appear in a command-line argument, file, environment variable, or
 * log. The script selects exactly one account by its full email address and
 * verifies the created draft's account and explicit To/Cc sets before send.
 */
export async function runOutlookAppleScript(request) {
  const mode = String(request?.mode ?? "");
  if (mode === "accounts") {
    const output = await runAppleScript(accountsScript());
    const accounts = output.split("\n").map(normalizeEmail).filter(Boolean);
    return { ok: true, bundleId: OUTLOOK_BUNDLE_ID, accounts };
  }
  if (mode === "account") {
    const senderAccount = requireEmail(request.senderAccount, "native_outlook_sender_invalid");
    const output = await runAppleScript(accountScript(senderAccount));
    const [tag, actual, count, offline, sendCapable] = output.split("\n");
    if (tag !== "OK") throw coded("native_outlook_account_probe_invalid");
    return {
      ok: true,
      bundleId: OUTLOOK_BUNDLE_ID,
      senderAccount: normalizeEmail(actual),
      accountMatches: Number(count),
      workingOffline: offline === "true",
      sendCapable: sendCapable === "true",
    };
  }
  if (mode === "send") {
    const envelope = validateRunnerEnvelope(request);
    const output = await runAppleScript(sendScript(envelope), { timeoutMs: 30_000 });
    const [tag, actual, count, recordId] = output.split("\n");
    if (tag !== "OK") throw coded("native_outlook_send_unconfirmed");
    return {
      ok: true,
      bundleId: OUTLOOK_BUNDLE_ID,
      senderAccount: normalizeEmail(actual),
      accountMatches: Number(count),
      outlookRecordId: String(recordId ?? "").trim(),
      to: envelope.to,
      cc: envelope.cc,
      bcc: [],
    };
  }
  throw coded("native_outlook_runner_mode_invalid");
}

function validateEnvelope(request, { contentRequired }) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw coded("native_outlook_request_invalid");
  if (request.client !== OUTLOOK_CLIENT || request.clientBundleId !== OUTLOOK_BUNDLE_ID) {
    throw coded("native_outlook_client_mismatch");
  }
  const from = requireEmail(request.senderAccount ?? request.from, "native_outlook_sender_invalid");
  const shape = Object.prototype.hasOwnProperty.call(request, "recipient") || typeof request.to === "string"
    ? "single"
    : "group";
  const to = shape === "single"
    ? [requireEmail(request.recipient ?? request.to, "native_outlook_to_invalid")]
    : validateRecipientArray(request.to, { required: true, code: "native_outlook_to_invalid" });
  const cc = shape === "single" ? [] : validateRecipientArray(request.cc, { required: false, code: "native_outlook_cc_invalid" });
  const bcc = shape === "single" ? [] : validateRecipientArray(request.bcc, { required: false, code: "native_outlook_bcc_invalid" });
  if (bcc.length !== 0) throw coded("native_outlook_bcc_forbidden");
  if (new Set([...to, ...cc]).size !== to.length + cc.length) throw coded("native_outlook_recipient_duplicate");
  if (!contentRequired) return Object.freeze({ shape, from, to, cc, subject: "", text: "", attachments: [] });
  const subject = validateText(request.subject, 160, "native_outlook_subject_invalid", false);
  const text = validateText(request.text, 25_000, "native_outlook_text_invalid", true);
  const attachments = validateNativeAttachments(request.attachments);
  return Object.freeze({ shape, from, to, cc, subject, text, attachments });
}

function validateRunnerEnvelope(request) {
  const from = requireEmail(request.senderAccount, "native_outlook_sender_invalid");
  const to = validateRecipientArray(request.to, { required: true, code: "native_outlook_to_invalid" });
  const cc = validateRecipientArray(request.cc, { required: false, code: "native_outlook_cc_invalid" });
  if (new Set([...to, ...cc]).size !== to.length + cc.length) throw coded("native_outlook_recipient_duplicate");
  return Object.freeze({
    from,
    to,
    cc,
    subject: validateText(request.subject, 160, "native_outlook_subject_invalid", false),
    text: validateText(request.text, 25_000, "native_outlook_text_invalid", true),
    attachments: validateNativeAttachments(request.attachments),
  });
}

function validateRecipientArray(input, { required, code }) {
  if (!Array.isArray(input) || input.length > 10 || (required && input.length < 1)) throw coded(code);
  const values = input.map((item) => requireEmail(item, code));
  if (new Set(values).size !== values.length) throw coded(code);
  return Object.freeze(values);
}

function validateNativeAttachments(input) {
  if (!Array.isArray(input) || input.length > 5) throw coded("native_outlook_attachments_invalid");
  return Object.freeze(input.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw coded("native_outlook_attachment_invalid");
    const filePath = path.resolve(String(item.path ?? ""));
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw coded("native_outlook_attachment_invalid");
    if (Number(item.byteSize) !== stat.size || !/^[a-f0-9]{64}$/u.test(String(item.sha256 ?? ""))) {
      throw coded("native_outlook_attachment_invalid");
    }
    const digest = createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    if (digest !== item.sha256) throw coded("native_outlook_attachment_invalid");
    return Object.freeze({ path: filePath, byteSize: stat.size, sha256: digest });
  }));
}

function accountsScript() {
  return `tell application id "${OUTLOOK_BUNDLE_ID}"
set candidateAccounts to {}
set candidateAccounts to candidateAccounts & (every exchange account)
set candidateAccounts to candidateAccounts & (every imap account)
set candidateAccounts to candidateAccounts & (every pop account)
set outputLines to {}
repeat with candidate in candidateAccounts
set end of outputLines to (email address of candidate as text)
end repeat
set AppleScript's text item delimiters to linefeed
return outputLines as text
end tell`;
}

function accountScript(senderAccount) {
  return `set requestedSender to ${appleScriptString(senderAccount)}
tell application id "${OUTLOOK_BUNDLE_ID}"
set candidateAccounts to {}
set candidateAccounts to candidateAccounts & (every exchange account)
set candidateAccounts to candidateAccounts & (every imap account)
set candidateAccounts to candidateAccounts & (every pop account)
set matchingAccounts to {}
repeat with candidate in candidateAccounts
if (email address of candidate as text) is requestedSender then set end of matchingAccounts to candidate
end repeat
set matchCount to count of matchingAccounts
if matchCount is not 1 then error "RICO_OUTLOOK_ACCOUNT_MATCH" number 7201
set selectedAccount to item 1 of matchingAccounts
set actualSender to email address of selectedAccount as text
set offlineState to working offline
set canSend to (activation state is full functionality)
return "OK" & linefeed & actualSender & linefeed & (matchCount as text) & linefeed & (offlineState as text) & linefeed & (canSend as text)
end tell`;
}

function sendScript(envelope) {
  const toLines = envelope.to.map((email) => `make new to recipient at newMessage with properties {email address:{address:${appleScriptString(email)}}}`).join("\n");
  const ccLines = envelope.cc.map((email) => `make new cc recipient at newMessage with properties {email address:{address:${appleScriptString(email)}}}`).join("\n");
  const attachmentLines = envelope.attachments.map((item) => `make new attachment at newMessage with properties {file:(POSIX file ${appleScriptString(item.path)})}`).join("\n");
  const expectedTo = appleScriptList(envelope.to);
  const expectedCc = appleScriptList(envelope.cc);
  return `set requestedSender to ${appleScriptString(envelope.from)}
set expectedTo to ${expectedTo}
set expectedCc to ${expectedCc}
tell application id "${OUTLOOK_BUNDLE_ID}"
set candidateAccounts to {}
set candidateAccounts to candidateAccounts & (every exchange account)
set candidateAccounts to candidateAccounts & (every imap account)
set candidateAccounts to candidateAccounts & (every pop account)
set matchingAccounts to {}
repeat with candidate in candidateAccounts
if (email address of candidate as text) is requestedSender then set end of matchingAccounts to candidate
end repeat
set matchCount to count of matchingAccounts
if matchCount is not 1 then error "RICO_OUTLOOK_ACCOUNT_MATCH" number 7201
if working offline then error "RICO_OUTLOOK_OFFLINE" number 7202
if activation state is not full functionality then error "RICO_OUTLOOK_NOT_SEND_CAPABLE" number 7203
set selectedAccount to item 1 of matchingAccounts
set actualSender to email address of selectedAccount as text
set newMessage to make new outgoing message with properties {subject:${appleScriptString(envelope.subject)}, plain text content:${appleScriptString(envelope.text)}, account:selectedAccount}
try
${toLines}
${ccLines}
${attachmentLines}
set actualMessageSender to email address of account of newMessage as text
if actualMessageSender is not requestedSender then error "RICO_OUTLOOK_SOURCE_FALLBACK" number 7204
set actualTo to {}
repeat with recipientItem in every to recipient of newMessage
set end of actualTo to address of email address of recipientItem as text
end repeat
set actualCc to {}
repeat with recipientItem in every cc recipient of newMessage
set end of actualCc to address of email address of recipientItem as text
end repeat
if my sortedText(actualTo) is not my sortedText(expectedTo) then error "RICO_OUTLOOK_TO_MISMATCH" number 7205
if my sortedText(actualCc) is not my sortedText(expectedCc) then error "RICO_OUTLOOK_CC_MISMATCH" number 7206
if (count of every bcc recipient of newMessage) is not 0 then error "RICO_OUTLOOK_BCC_FORBIDDEN" number 7207
set localRecordID to id of newMessage as text
send newMessage
return "OK" & linefeed & actualMessageSender & linefeed & (matchCount as text) & linefeed & localRecordID
on error errorMessage number errorNumber
try
if (exists newMessage) and (was sent of newMessage is false) then delete newMessage
end try
error errorMessage number errorNumber
end try
end tell

on sortedText(valuesList)
set workList to {}
repeat with valueItem in valuesList
set end of workList to (valueItem as text)
end repeat
set itemCount to count workList
repeat with i from 1 to itemCount
repeat with j from (i + 1) to itemCount
if j is less than or equal to itemCount then
if item j of workList comes before item i of workList then
set temporaryValue to item i of workList
set item i of workList to item j of workList
set item j of workList to temporaryValue
end if
end if
end repeat
end repeat
set AppleScript's text item delimiters to linefeed
return workList as text
end sortedText`;
}

function appleScriptString(value) {
  const text = String(value).replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
  return `"${text}"`;
}

function appleScriptList(values) {
  return `{${values.map(appleScriptString).join(", ")}}`;
}

function runAppleScript(script, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", ["-"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(coded("native_outlook_automation_timeout"));
    }, timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 64 * 1024) finish(coded("native_outlook_automation_output_too_large"));
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 64 * 1024) finish(coded("native_outlook_automation_output_too_large"));
    });
    child.on("error", () => finish(coded("native_outlook_automation_unavailable")));
    child.on("close", (code) => {
      if (code !== 0) return finish(coded(classifyAppleScriptError(stderr)));
      finish(null, stdout.trim());
    });
    child.stdin.on("error", () => finish(coded("native_outlook_automation_unavailable")));
    child.stdin.end(script, "utf8");
  });
}

async function readPlistValue(plistPath, key) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plistPath], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", () => reject(coded("native_outlook_plist_unavailable")));
    child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(coded("native_outlook_plist_invalid")));
  });
}

function classifyAppleScriptError(stderr) {
  const value = String(stderr ?? "");
  if (/-1743\b/u.test(value) || /not authorized|not permitted|automation/iu.test(value)) return "native_outlook_automation_denied";
  if (/7201\b/u.test(value)) return "native_outlook_source_account_unproven";
  if (/7202\b/u.test(value)) return "native_outlook_offline";
  if (/7203\b/u.test(value)) return "native_outlook_not_send_capable";
  if (/7204\b/u.test(value)) return "native_outlook_source_fallback";
  if (/7205\b/u.test(value)) return "native_outlook_send_to_mismatch";
  if (/7206\b/u.test(value)) return "native_outlook_send_cc_mismatch";
  if (/7207\b/u.test(value)) return "native_outlook_send_bcc_forbidden";
  return "native_outlook_automation_failed";
}

function requireEmail(value, code) {
  const email = normalizeEmail(value);
  if (!email) throw coded(code);
  return email;
}

function validateText(input, maxCharacters, code, multiline) {
  const value = String(input ?? "").normalize("NFC").replace(/\r\n/gu, "\n").trim();
  if (!value || [...value].length > maxCharacters || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
      || /\r/u.test(value) || (!multiline && /\n/u.test(value))) throw coded(code);
  return value;
}

function assertExactRecipients(actual, expected, code) {
  if (!Array.isArray(actual)) throw coded(code);
  const normalized = actual.map(normalizeEmail);
  const left = [...new Set(normalized)].sort();
  const right = [...new Set(expected)].sort();
  if (normalized.some((item) => !item) || left.length !== normalized.length || left.length !== right.length
      || !left.every((item, index) => item === right[index])) throw coded(code);
}

function safeErrorCode(error) {
  return String(error?.code ?? error?.name ?? "unknown").toLowerCase().replace(/[^a-z0-9_-]+/gu, "_").slice(0, 80) || "unknown";
}

function coded(code) {
  return new RicoEmailPolicyError(code);
}
