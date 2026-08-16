import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE } from "./constants.mjs";
import { governed } from "./errors.mjs";

const execFile = promisify(execFileCallback);

/**
 * Reads exactly one generic-password item. The secret is never placed in an
 * argument, environment variable, file, or diagnostic. The raw Buffer is
 * wiped when the callback exits.
 */
export class MacOSOpenTableCredentialProvider {
  constructor({ execFileFn = execFile } = {}) {
    this.execFileFn = execFileFn;
  }

  async status() {
    try {
      await this.withSecret(async (secret) => ({ bytes: secret.length }));
      return Object.freeze({ available: true, service: KEYCHAIN_SERVICE, account: KEYCHAIN_ACCOUNT });
    } catch (error) {
      return Object.freeze({
        available: false,
        service: KEYCHAIN_SERVICE,
        account: KEYCHAIN_ACCOUNT,
        code: error?.code ?? "keychain_missing",
      });
    }
  }

  async withSecret(operation) {
    let secret;
    let stdout;
    try {
      const result = await this.execFileFn("/usr/bin/security", [
        "find-generic-password",
        "-s", KEYCHAIN_SERVICE,
        "-a", KEYCHAIN_ACCOUNT,
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
      if (secret.length === 0) throw governed("keychain_empty", "OpenTable partner credentials are missing from macOS Keychain.");
      return await operation(secret);
    } catch (error) {
      if (error?.code === "keychain_empty") throw error;
      throw governed("keychain_missing", "OpenTable partner credentials are missing from macOS Keychain.");
    } finally {
      stdout?.fill(0);
      secret?.fill(0);
    }
  }
}

function trimNewline(value) {
  let end = value.length;
  while (end > 0 && (value[end - 1] === 0x0a || value[end - 1] === 0x0d)) end -= 1;
  return Buffer.from(value.subarray(0, end));
}
