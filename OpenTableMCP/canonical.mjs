import crypto from "node:crypto";
import { governed } from "./errors.mjs";

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

export function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

export function randomId() {
  return crypto.randomUUID();
}

export function randomChallenge(prefix) {
  const code = crypto.randomInt(100000, 1000000);
  return `${prefix} ${code}`;
}

export function exactObject(value, keys, code = "invalid_object") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw governed(code, "A required object is invalid.");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.join("\u0000") !== expected.join("\u0000")) throw governed(code, "The object contains missing or unexpected fields.");
  return value;
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = sortValue(value[key]);
    return result;
  }
  return value;
}
