import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GRANT_SCHEMA = "rico.outlook-mail-monitor-grant";
const SIMPLE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const E164 = /^\+[1-9]\d{7,14}$/u;

export function defaultStateDirectory(homeDirectory = os.homedir()) {
  return path.join(
    path.resolve(homeDirectory),
    "Library",
    "Application Support",
    "OpenClaw Studio",
    "workflows",
    "outlook-mail-monitor",
  );
}

export function defaultGrantPath(homeDirectory = os.homedir()) {
  return path.join(defaultStateDirectory(homeDirectory), "permission-grant.json");
}

export function validatePermissionGrant(input) {
  const value = requireObject(input, "permission grant");
  exactKeys(value, [
    "schema",
    "schemaVersion",
    "mailboxId",
    "folderMonitor",
    "senderMonitor",
    "imessage",
    "issuedAt",
  ], "permission grant");
  if (value.schema !== GRANT_SCHEMA || value.schemaVersion !== 1) throw new Error("unsupported permission grant schema");

  const mailboxId = normalizeEmail(value.mailboxId, "mailboxId");
  const folderMonitor = requireObject(value.folderMonitor, "folderMonitor");
  exactKeys(folderMonitor, ["folderPath", "alertText"], "folderMonitor");
  const folderPath = normalizeFolderPath(folderMonitor.folderPath, { childRequired: true });

  const senderMonitor = requireObject(value.senderMonitor, "senderMonitor");
  exactKeys(senderMonitor, ["folderPath", "senderAddress", "alertText"], "senderMonitor");
  const senderFolderPath = normalizeFolderPath(senderMonitor.folderPath, { childRequired: false });
  if (senderFolderPath !== "Inbox") throw new Error("senderMonitor.folderPath must be Inbox");

  const imessage = requireObject(value.imessage, "imessage");
  exactKeys(imessage, ["sourceAccount", "destination"], "imessage");
  const destination = String(imessage.destination ?? "").trim();
  if (!E164.test(destination)) throw new Error("imessage.destination must be an E.164 address");

  const issuedAt = normalizeTimestamp(value.issuedAt, "issuedAt");
  return deepFreeze({
    schema: GRANT_SCHEMA,
    schemaVersion: 1,
    mailboxId,
    folderMonitor: {
      folderPath,
      alertText: normalizeAlertText(folderMonitor.alertText, "folderMonitor.alertText"),
    },
    senderMonitor: {
      folderPath: senderFolderPath,
      senderAddress: normalizeEmail(senderMonitor.senderAddress, "senderMonitor.senderAddress"),
      alertText: normalizeAlertText(senderMonitor.alertText, "senderMonitor.alertText"),
    },
    imessage: {
      sourceAccount: normalizeEmail(imessage.sourceAccount, "imessage.sourceAccount"),
      destination,
    },
    issuedAt,
  });
}

export function ensurePrivateDirectory(directory) {
  const resolved = path.resolve(directory);
  const existed = fs.existsSync(resolved);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("private state path is not a real directory");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("private state directory has the wrong owner");
  if ((stat.mode & 0o777) !== 0o700) {
    // Never chmod an operator-selected existing directory: a mistaken broad
    // path (for example a home directory) must fail instead of changing it.
    if (existed) throw new Error("existing private state directory mode must be 0700");
    fs.chmodSync(resolved, 0o700);
  }
  return resolved;
}

export function assertPrivateDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("private directory is not a real directory");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("private directory has the wrong owner");
  if ((stat.mode & 0o777) !== 0o700) throw new Error("private directory mode must be 0700");
}

export function assertPrivateFile(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("private file is not a regular file");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("private file has the wrong owner");
  if ((stat.mode & 0o777) !== 0o600) throw new Error("private file mode must be 0600");
}

export function readPrivateGrant(filePath = defaultGrantPath()) {
  const resolved = path.resolve(filePath);
  assertPrivateDirectory(path.dirname(resolved));
  assertPrivateFile(resolved);
  return validatePermissionGrant(JSON.parse(fs.readFileSync(resolved, "utf8")));
}

export function installPrivateGrant(value, { filePath = defaultGrantPath(), replace = false } = {}) {
  const grant = validatePermissionGrant(value);
  const resolved = path.resolve(filePath);
  const directory = ensurePrivateDirectory(path.dirname(resolved));
  if (fs.existsSync(resolved) && !replace) throw new Error("permission grant already exists; pass --replace only after explicit review");
  if (fs.existsSync(resolved)) assertPrivateFile(resolved);
  writePrivateJson(resolved, grant, { backup: fs.existsSync(resolved) });
  return resolved;
}

export function writePrivateJson(filePath, value, { backup = false } = {}) {
  const resolved = path.resolve(filePath);
  const directory = ensurePrivateDirectory(path.dirname(resolved));
  const temporary = path.join(directory, `.${path.basename(resolved)}.${process.pid}.${Date.now()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.chmodSync(temporary, 0o600);
    if (backup && fs.existsSync(resolved)) {
      const backupPath = path.join(directory, `${path.basename(resolved)}.backup.${Date.now()}`);
      fs.copyFileSync(resolved, backupPath, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(backupPath, 0o600);
    }
    fs.renameSync(temporary, resolved);
    assertPrivateFile(resolved);
    const directoryDescriptor = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function normalizeEmail(input, label) {
  const value = String(input ?? "").trim().toLowerCase();
  if (!SIMPLE_EMAIL.test(value) || value.length > 254) throw new Error(`${label} must be an email address`);
  return value;
}

function normalizeFolderPath(input, { childRequired }) {
  const raw = String(input ?? "").trim();
  if (!raw || raw.startsWith("/") || raw.endsWith("/") || raw.includes("\\") || raw.includes("//")) {
    throw new Error("folder path is invalid");
  }
  const parts = raw.split("/").map((part) => part.trim());
  if (parts.some((part) => !part || part === "." || part === ".." || part.length > 120)) throw new Error("folder path is invalid");
  if (parts[0].toLowerCase() !== "inbox") throw new Error("folder path must be under Inbox");
  if (childRequired && parts.length !== 2) throw new Error("folder monitor must name one folder directly under Inbox");
  if (!childRequired && parts.length !== 1) throw new Error("sender monitor must use Inbox");
  return parts.map((part, index) => index === 0 ? "Inbox" : part).join("/");
}

function normalizeAlertText(input, label) {
  const value = String(input ?? "").trim();
  if (!value || value.length > 300 || /[\r\n]/u.test(value)) throw new Error(`${label} must be one non-empty line`);
  return value;
}

function normalizeTimestamp(input, label) {
  const value = String(input ?? "").trim();
  const timestamp = Date.parse(value);
  if (!value || !Number.isFinite(timestamp)) throw new Error(`${label} must be an ISO timestamp`);
  return new Date(timestamp).toISOString();
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exactKeys(value, keys, label) {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) throw new Error(`${label} has unexpected fields`);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
