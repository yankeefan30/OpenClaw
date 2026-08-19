import { execFile as execFileCallback } from "node:child_process";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE } from "./constants.mjs";
import { parseCredentialBundle } from "./credentials.mjs";
import { fail } from "./errors.mjs";

const execFile = promisify(execFileCallback);
const HELPER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "KeychainWriteHelper.swift");

export class MacOSPressmasterCredentialProvider {
  constructor({
    execFileFn = execFile,
    replaceSecretFn = runSwiftKeychainHelper,
    service = KEYCHAIN_SERVICE,
    account = KEYCHAIN_ACCOUNT,
  } = {}) {
    this.execFileFn = execFileFn;
    this.replaceSecretFn = replaceSecretFn;
    this.service = service;
    this.account = account;
  }

  async status() {
    try {
      await this.withSecret(async (secret) => secret.length);
      return Object.freeze({ available: true, source: "keychain", service: this.service, account: this.account });
    } catch (error) {
      return Object.freeze({
        available: false,
        source: "keychain",
        service: this.service,
        account: this.account,
        code: error?.code ?? "keychain_missing",
      });
    }
  }

  async withSecret(operation) {
    let stdout;
    let secret;
    try {
      const result = await this.execFileFn("/usr/bin/security", [
        "find-generic-password",
        "-s", this.service,
        "-a", this.account,
        "-w",
      ], {
        encoding: "buffer",
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
        env: { PATH: "/usr/bin:/bin" },
      });
      stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
      secret = trimNewline(stdout);
      stdout.fill(0);
      if (secret.length === 0) throw fail("keychain_empty", "Pressmaster OAuth credentials are missing from macOS Keychain.");
      return await operation(secret);
    } catch (error) {
      if (error?.code === "keychain_empty" || error?.code === "credential_bundle_invalid" || error?.code === "credential_bundle_schema_invalid") {
        throw error;
      }
      throw fail("keychain_missing", "Pressmaster OAuth credentials are missing from macOS Keychain.");
    } finally {
      stdout?.fill(0);
      secret?.fill(0);
    }
  }

  async readBundle(now = new Date()) {
    return this.withSecret(async (secret) => parseCredentialBundle(secret, now));
  }

  async replaceBundle(bundle) {
    const serialized = Buffer.from(`${JSON.stringify(bundle)}\n`, "utf8");
    try {
      await this.replaceSecretFn(serialized, {
        helperPath: HELPER_PATH,
        service: this.service,
        account: this.account,
      });
    } catch {
      throw fail("keychain_write_failed", "The Pressmaster OAuth bundle could not be written to macOS Keychain.");
    } finally {
      serialized.fill(0);
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
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error("Keychain helper failed"));
    });
    child.stdin.once("error", () => {});
    child.stdin.end(secret);
  });
}
