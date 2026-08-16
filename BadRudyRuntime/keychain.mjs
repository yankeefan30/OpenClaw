import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { codedError } from "./errors.mjs";

const execFile = promisify(execFileCallback);
export const GROK_KEYCHAIN_SERVICE = "openclaw-grok";
export const GROK_KEYCHAIN_ACCOUNT = "alan";

/**
 * Reads the one reviewed Keychain item without ever placing it in arguments,
 * environment variables, UI state, or a file. Callers only receive the
 * secret for the duration of `withCredential`; the Buffer is wiped afterward.
 */
export class MacOSGrokCredentialProvider {
  constructor({ execFileFn = execFile } = {}) {
    this.execFileFn = execFileFn;
  }

  async status() {
    try {
      await this.withCredential(async () => undefined);
      return Object.freeze({ available: true, service: GROK_KEYCHAIN_SERVICE, account: GROK_KEYCHAIN_ACCOUNT });
    } catch (error) {
      return Object.freeze({ available: false, service: GROK_KEYCHAIN_SERVICE, account: GROK_KEYCHAIN_ACCOUNT, code: error?.code ?? "keychain_missing" });
    }
  }

  async withCredential(operation) {
    let credential;
    try {
      const result = await this.execFileFn("/usr/bin/security", [
        "find-generic-password",
        "-s", GROK_KEYCHAIN_SERVICE,
        "-a", GROK_KEYCHAIN_ACCOUNT,
        "-w",
      ], {
        encoding: "buffer",
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
        env: { PATH: "/usr/bin:/bin" },
      });
      const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
      credential = trimTrailingNewline(stdout);
      stdout.fill(0);
      if (credential.length === 0) throw codedError("keychain_empty", "Grok credentials are missing from macOS Keychain.");
      return await operation(credential);
    } catch (error) {
      if (error?.code === "keychain_empty") throw error;
      throw codedError("keychain_missing", "Grok credentials are missing from macOS Keychain.");
    } finally {
      credential?.fill(0);
    }
  }
}

function trimTrailingNewline(value) {
  let end = value.length;
  while (end > 0 && (value[end - 1] === 0x0a || value[end - 1] === 0x0d)) end -= 1;
  return Buffer.from(value.subarray(0, end));
}
