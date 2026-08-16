import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { defaultOpenClawConfigPath, defaultTokenDirectory, defaultTokenPath, studioSupportDirectory } from "./constants.mjs";
import { fail } from "./errors.mjs";

export function ensurePrivateDirectory(directory, mode = 0o700) {
  fs.mkdirSync(directory, { recursive: true, mode });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw fail("secret_store_unavailable", "Secret directory is not a private folder.");
  }
  if ((stat.mode & 0o777) !== mode) fs.chmodSync(directory, mode);
}

export function ensureBearerTokenFile(tokenPath = defaultTokenPath()) {
  const resolved = path.resolve(tokenPath);
  const directory = path.dirname(resolved);
  const support = path.resolve(studioSupportDirectory());
  if (resolved === support || resolved.startsWith(`${support}${path.sep}`)) {
    ensurePrivateDirectory(support);
  }
  ensurePrivateDirectory(directory);

  if (fs.existsSync(tokenPath)) {
    assertPrivateFile(tokenPath);
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (!existing) throw fail("secret_store_unavailable", "Bearer token file is empty.");
    return { path: tokenPath, created: false };
  }

  const token = crypto.randomBytes(32).toString("base64url");
  const tmp = `${tokenPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${token}\n`, { mode: 0o600, flag: "wx" });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, tokenPath);
  fs.chmodSync(tokenPath, 0o600);
  return { path: tokenPath, created: true };
}

export function readBearerToken(tokenPath = defaultTokenPath()) {
  assertPrivateFile(tokenPath);
  const token = fs.readFileSync(tokenPath, "utf8").trim();
  if (!token) throw fail("unauthorized", "Bearer token is unavailable.", { status: 401 });
  return token;
}

export function tokensMatch(expected, provided) {
  const left = Buffer.from(String(expected ?? ""), "utf8");
  const right = Buffer.from(String(provided ?? ""), "utf8");
  if (left.length === 0 || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function readGatewayToken(configPath = defaultOpenClawConfigPath()) {
  const config = readJsonObject(configPath);
  const token = config?.gateway?.auth?.token;
  if (typeof token === "string" && token.trim()) return token.trim();
  if (token && typeof token === "object" && !Array.isArray(token) && typeof token.$file === "string") {
    const file = token.$file.startsWith("~/")
      ? path.join(process.env.HOME ?? "", token.$file.slice(2))
      : token.$file;
    assertPrivateFile(file);
    const value = fs.readFileSync(file, "utf8").trim();
    if (value) return value;
  }
  throw fail("gateway_auth_unavailable", "Gateway authentication is unavailable.");
}

export function readOpenClawConfig(configPath = defaultOpenClawConfigPath()) {
  return readJsonObject(configPath);
}

function readJsonObject(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw fail("config_unavailable", "OpenClaw configuration is unavailable.");
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw fail("config_unavailable", "OpenClaw configuration is unavailable.");
  }
  return parsed;
}

function assertPrivateFile(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw fail("secret_store_unavailable", "Secret file is not a private regular file.");
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw fail("secret_store_unavailable", "Secret file permissions must be 0600.");
  }
}
