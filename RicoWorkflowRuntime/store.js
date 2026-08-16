import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const STORE_SCHEMA = "openclaw.rico-workflow/v1";

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isPrivateFile(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    if ((stat.mode & 0o777) !== 0o600) return false;
    return typeof process.getuid !== "function" || stat.uid === process.getuid();
  } catch {
    return false;
  }
}

function isPrivateDirectory(directoryPath) {
  try {
    const stat = fs.lstatSync(directoryPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if ((stat.mode & 0o777) !== 0o700) return false;
    return typeof process.getuid !== "function" || stat.uid === process.getuid();
  } catch {
    return false;
  }
}

export function defaultStorePath() {
  return path.join(os.homedir(), "Library", "Application Support", "OpenClaw Studio", "rico-workflows.json");
}

export class WorkflowStore {
  constructor(filePath = defaultStorePath()) {
    this.filePath = filePath;
  }

  ensure() {
    const directory = path.dirname(this.filePath);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    if (!isPrivateDirectory(directory)) throw coded("workflow_store_unsafe", "Rico workflow storage is not private.");
    if (!fs.existsSync(this.filePath)) {
      this.write({ schema: STORE_SCHEMA, workflows: [] });
    }
    if (!isPrivateFile(this.filePath)) throw coded("workflow_store_unsafe", "Rico workflow storage is not private.");
  }

  read() {
    this.ensure();
    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    if (parsed?.schema !== STORE_SCHEMA || !Array.isArray(parsed.workflows)) {
      throw coded("workflow_store_invalid", "Rico workflow storage is invalid.");
    }
    return parsed;
  }

  write(state) {
    const directory = path.dirname(this.filePath);
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
  }

  list() {
    return this.read().workflows;
  }

  save(record) {
    const state = this.read();
    const index = state.workflows.findIndex((item) => item.id === record.id);
    if (index >= 0) state.workflows[index] = record;
    else state.workflows.push(record);
    this.write(state);
    return record;
  }

  remove(id) {
    const state = this.read();
    const next = state.workflows.filter((item) => item.id !== id);
    if (next.length === state.workflows.length) throw coded("workflow_not_found", "That workflow is not installed.");
    this.write({ ...state, workflows: next });
  }
}

export function newWorkflowId() {
  return `wf_${crypto.randomBytes(8).toString("hex")}`;
}
