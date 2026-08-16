import crypto from "node:crypto";
import { governed } from "./errors.mjs";

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

export function sha256(value) {
  const input = typeof value === "string" ? value : canonicalJson(value);
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function randomId() {
  return crypto.randomUUID();
}

export function randomChallenge(prefix) {
  return `${prefix} ${crypto.randomInt(100000, 1000000)}`;
}

export function exactObject(value, keys, code = "object_invalid") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw governed(code, "A required object is invalid.");
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.join("\u0000") !== expected.join("\u0000")) {
    throw governed(code, "The object contains missing or unexpected fields.");
  }
  return value;
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const output = {};
    for (const key of Object.keys(value).sort()) output[key] = sortValue(value[key]);
    return output;
  }
  return value;
}
