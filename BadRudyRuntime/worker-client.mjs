import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { codedError } from "./errors.mjs";
import { REQUIRED_WORKER_CAPABILITY } from "./config.mjs";

/**
 * Narrow stdio protocol for workers/grok-companions. Prompts are written to
 * the child's stdin; credentials are read independently by the worker from the
 * same fixed Keychain item. Neither appears in argv or env. The worker must
 * emit exactly one JSON result on stdout and code-only diagnostics on stderr.
 */
export class StdioPlaywrightWorkerClient {
  constructor({ nodeExecutable, workerEntry, homeDirectory = os.homedir(), spawnFn = spawn, captureTimeoutMs = 180_000 }) {
    this.nodeExecutable = nodeExecutable;
    this.workerEntry = workerEntry;
    this.homeDirectory = homeDirectory;
    this.spawnFn = spawnFn;
    this.captureTimeoutMs = captureTimeoutMs;
  }

  async health() {
    try {
      const statusInput = Buffer.from(JSON.stringify({ killSwitch: false, dryRun: true, allowlistReady: true }), "utf8");
      let value;
      try {
        value = await this.#run(["--status"], statusInput, 15_000);
      } finally {
        statusInput.fill(0);
      }
      const exactCapability = value?.capabilities?.[REQUIRED_WORKER_CAPABILITY] === true;
      return Object.freeze({
        ready: value?.ready === true && exactCapability,
        playwright: value?.playwright === "ready" ? "ready" : "down",
        ffmpeg: value?.ffmpeg === "ready" ? "ready" : "down",
        capabilities: Object.freeze({ [REQUIRED_WORKER_CAPABILITY]: exactCapability }),
        code: exactCapability ? String(value?.code ?? "ok") : "bad_rudy_web_capability_unavailable",
      });
    } catch (error) {
      return Object.freeze({
        ready: false,
        playwright: "down",
        ffmpeg: "down",
        capabilities: Object.freeze({ [REQUIRED_WORKER_CAPABILITY]: false }),
        code: String(error?.code ?? "worker_health_failed"),
      });
    }
  }

  async capture({ credential, ...request }) {
    if (!Buffer.isBuffer(credential) || credential.length === 0) throw codedError("keychain_missing", "Grok credentials are unavailable.");
    // The worker independently reads the same fixed Keychain item. Credential
    // bytes are accepted here only so this boundary can prove the runtime gate
    // was exercised; they are deliberately excluded from the stdio request.
    const payload = Buffer.from(JSON.stringify({
      prompt: request.prompt,
      source: "human:studio",
      requiredCapability: request.requiredCapability,
      advanced: {
        format: request.format,
        maxDurationSeconds: request.maxDurationSeconds,
        exportStill: request.exportStill,
        retries: request.retries,
      },
      governance: request.governance,
    }), "utf8");
    try {
      return await this.#run(["--capture"], payload, this.captureTimeoutMs);
    } finally {
      payload.fill(0);
    }
  }

  async #run(argumentsList, stdin, timeoutMs) {
    this.#assertExecutableInputs();
    return new Promise((resolve, reject) => {
      const child = this.spawnFn(this.nodeExecutable, ["--experimental-strip-types", this.workerEntry, ...argumentsList], {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        env: {
          HOME: this.homeDirectory,
          PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
          LANG: "en_US.UTF-8",
        },
      });
      const stdout = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(reject, codedError("worker_timeout", "The bounded Playwright worker timed out."));
      }, timeoutMs);
      const finish = (operation, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        operation(value);
      };
      child.on("error", () => finish(reject, codedError("worker_launch_failed", "The bounded Playwright worker could not start.")));
      child.stdout.on("data", (chunk) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > 2 * 1024 * 1024) {
          child.kill("SIGTERM");
          finish(reject, codedError("worker_output_too_large", "The bounded Playwright worker returned too much data."));
          return;
        }
        stdout.push(Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk) => {
        // Never surface worker stderr: a browser dependency could accidentally
        // include a URL or session detail. Only retain the bounded byte count.
        stderrBytes += chunk.length;
        if (stderrBytes > 256 * 1024) child.kill("SIGTERM");
      });
      child.on("close", (code) => {
        if (settled) return;
        if (code !== 0 || stderrBytes > 256 * 1024) {
          finish(reject, codedError("worker_failed", "The bounded Playwright worker failed. Review its local screenshot-on-failure artifact."));
          return;
        }
        try {
          const text = Buffer.concat(stdout).toString("utf8");
          const value = JSON.parse(text);
          finish(resolve, value);
        } catch {
          finish(reject, codedError("worker_protocol_invalid", "The bounded Playwright worker returned invalid JSON."));
        } finally {
          for (const chunk of stdout) chunk.fill(0);
        }
      });
      if (stdin) child.stdin.end(stdin);
      else child.stdin.end();
    });
  }

  #assertExecutableInputs() {
    for (const [label, file] of [["Node", this.nodeExecutable], ["worker", this.workerEntry]]) {
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        throw codedError("worker_unavailable", `${label} is unavailable for the bounded Playwright worker.`);
      }
      if (!stat.isFile()) throw codedError("worker_unavailable", `${label} is unavailable for the bounded Playwright worker.`);
    }
  }
}
