import { execFile as execFileCallback } from "node:child_process";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE } from "./constants.mjs";
import { governed } from "./errors.mjs";

const execFile = promisify(execFileCallback);
const HELPER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "KeychainWriteHelper.swift");

export class MacOSUberCredentialProvider {
  constructor({ execFileFn = execFile, replaceSecretFn = runSwiftKeychainHelper } = {}) {
    this.execFileFn = execFileFn;
    this.replaceSecretFn = replaceSecretFn;
  }

  async status() {
    try {
      await this.withSecret(async (secret) => secret.length);
      return Object.freeze({ available: true, service: KEYCHAIN_SERVICE, account: KEYCHAIN_ACCOUNT });
    } catch (error) {
      return Object.freeze({ available: false, service: KEYCHAIN_SERVICE, account: KEYCHAIN_ACCOUNT, code: error?.code ?? "keychain_missing" });
    }
  }

  async withSecret(operation) {
    let stdout;
    let secret;
    try {
      const result = await this.execFileFn("/usr/bin/security", [
        "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w",
      ], {
        encoding: "buffer",
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
        env: { PATH: "/usr/bin:/bin" },
      });
      stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
      secret = trimNewline(stdout);
      stdout.fill(0);
      if (secret.length === 0) throw governed("keychain_empty", "Uber OAuth credentials are missing from macOS Keychain.");
      return await operation(secret);
    } catch (error) {
      if (error?.code === "keychain_empty") throw error;
      throw governed("keychain_missing", "Uber OAuth credentials are missing from macOS Keychain.");
    } finally {
      stdout?.fill(0);
      secret?.fill(0);
    }
  }

  async replaceSecret(nextSecret) {
    if (!Buffer.isBuffer(nextSecret) || nextSecret.length < 32 || nextSecret.length > 1024 * 1024) {
      throw governed("keychain_rotation_invalid", "The rotated Uber OAuth bundle is invalid.");
    }
    try {
      await this.replaceSecretFn(nextSecret, { helperPath: HELPER_PATH, service: KEYCHAIN_SERVICE, account: KEYCHAIN_ACCOUNT });
    } catch {
      throw governed("keychain_rotation_failed", "The rotated Uber OAuth bundle could not be committed directly to macOS Keychain.");
    }
  }
}

function trimNewline(value) {
  let end = value.length;
  while (end > 0 && (value[end - 1] === 0x0a || value[end - 1] === 0x0d)) end -= 1;
  return Buffer.from(value.subarray(0, end));
}

function runSwiftKeychainHelper(secret, { helperPath, service, account }) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/swift", [helperPath, service, account], {
      stdio: ["pipe", "ignore", "pipe"],
      env: { PATH: "/usr/bin:/bin" },
    });
    let stderrBytes = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    timer.unref?.();
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 64 * 1024) child.kill("SIGKILL");
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("Keychain helper failed")); });
    child.stdin.once("error", () => {});
    child.stdin.end(secret);
  });
}
