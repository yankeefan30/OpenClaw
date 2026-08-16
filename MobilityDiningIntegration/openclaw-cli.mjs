import { spawnSync } from "node:child_process";

const MAX_OUTPUT_BYTES = 1024 * 1024;

export class OpenClawMcpRegistry {
  constructor({ nodePath, openclawEntry, configPath, stateDirectory, spawn = spawnSync } = {}) {
    if (![nodePath, openclawEntry, configPath, stateDirectory].every((item) => typeof item === "string" && item.startsWith("/"))) {
      throw new Error("OpenClaw registry paths must be absolute.");
    }
    this.nodePath = nodePath;
    this.openclawEntry = openclawEntry;
    this.configPath = configPath;
    this.stateDirectory = stateDirectory;
    this.spawn = spawn;
  }

  get(name) {
    const result = this.run(["mcp", "show", name, "--json"], { allowMissing: true });
    if (result.missing) return null;
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error(`OpenClaw returned invalid JSON for MCP server ${name}.`);
    }
  }

  set(name, value) {
    this.run(["mcp", "set", name, JSON.stringify(value)]);
  }

  unset(name) {
    this.run(["mcp", "unset", name]);
  }

  validateConfig() {
    this.run(["config", "validate"]);
  }

  run(arguments_, { allowMissing = false } = {}) {
    const result = this.spawn(this.nodePath, [this.openclawEntry, ...arguments_], {
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: {
        PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: process.env.HOME,
        OPENCLAW_CONFIG_PATH: this.configPath,
        OPENCLAW_STATE_DIR: this.stateDirectory,
        NO_COLOR: "1",
      },
    });
    const stdout = String(result.stdout ?? "");
    const stderr = String(result.stderr ?? "");
    if (result.status === 0) return Object.freeze({ stdout, stderr, missing: false });
    if (allowMissing && /No MCP server named/u.test(`${stdout}\n${stderr}`)) {
      return Object.freeze({ stdout: "", stderr: "", missing: true });
    }
    const reason = result.error?.code || `exit_${result.status ?? "unknown"}`;
    throw new Error(`OpenClaw MCP registry command failed (${reason}).`);
  }
}

