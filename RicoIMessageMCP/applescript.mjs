import { spawn } from "node:child_process";
import { fail } from "./errors.mjs";

const MAX_OUTPUT_BYTES = 256 * 1024;

export function appleScriptString(value) {
  const text = String(value).replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
  return `"${text}"`;
}

export function classifyAutomationError(stderr, fallback = "automation_failed") {
  const value = String(stderr ?? "");
  if (/-1743\b/u.test(value) || /not authorized|not permitted|automation/iu.test(value)) {
    return "automation_denied";
  }
  if (/7301\b/u.test(value) || /RICO_MAIL_NOT_FOUND/u.test(value)) return "mail_not_found";
  if (/7302\b/u.test(value) || /RICO_CALENDAR_NOT_FOUND/u.test(value)) return "calendar_not_found";
  if (/7303\b/u.test(value) || /RICO_MAILBOX_NOT_FOUND/u.test(value) || /RICO_MAIL_ACCOUNT_NOT_FOUND/u.test(value)) {
    return "mail_account_not_found";
  }
  return fallback;
}

export function jsString(value) {
  return JSON.stringify(String(value ?? ""));
}

export function runOsascript(script, { timeoutMs = 12_000, language } = {}) {
  return new Promise((resolve, reject) => {
    const args = language === "javascript" ? ["-l", "JavaScript", "-"] : ["-"];
    const child = spawn("/usr/bin/osascript", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(fail("local_app_timeout", "The local Apple app did not respond in time.", { retryable: true }));
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
      if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) {
        finish(fail("automation_output_too_large", "The local Apple app returned too much data."));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, "utf8") > MAX_OUTPUT_BYTES) {
        finish(fail("automation_output_too_large", "The local Apple app returned too much data."));
      }
    });
    child.on("error", () => finish(fail("automation_unavailable", "AppleScript is unavailable.")));
    child.on("close", (code) => {
      if (code !== 0) {
        const errorCode = classifyAutomationError(stderr);
        finish(fail(errorCode, errorCode === "automation_denied"
          ? "macOS Automation permission is required. Allow node to control the local app, then retry."
          : "The local Apple app could not complete the request."));
        return;
      }
      finish(null, stdout.trim());
    });
    child.stdin.on("error", () => finish(fail("automation_unavailable", "AppleScript is unavailable.")));
    child.stdin.end(script, "utf8");
  });
}

export function parseOkRecords(stdout, fieldCount) {
  const text = String(stdout ?? "").trim();
  const lines = text.split("\n");
  if (lines[0] !== "RICO_OK") {
    throw fail("automation_failed", "The local Apple app returned an unexpected result.");
  }
  const total = Number(lines[1] ?? 0);
  const count = Number(lines[2] ?? 0);
  const rows = [];
  if (lines.length > 3 && lines[3]) {
    for (const record of lines[3].split("\u001e")) {
      if (!record) continue;
      const fields = record.split("\u001f");
      if (fields.length !== fieldCount) {
        throw fail("automation_failed", "The local Apple app returned an unexpected result.");
      }
      rows.push(fields);
    }
  }
  return { total: Number.isInteger(total) ? total : 0, count: Number.isInteger(count) ? count : rows.length, rows };
}

export function clipText(value, maxChars) {
  const text = String(value ?? "").normalize("NFC").replace(/\r\n/gu, "\n");
  if ([...text].length <= maxChars) return text;
  return [...text].slice(0, maxChars).join("");
}
