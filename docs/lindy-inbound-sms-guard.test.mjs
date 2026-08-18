import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const dir = dirname(fileURLToPath(import.meta.url));
const listed = [
  "LINDY_INBOUND_SMS.md",
  "lindy-inbound-sms.example.json",
  "lindy-inbound-sms-guard.test.mjs",
];
const scanned = listed.filter((name) => name.endsWith(".md") || name.endsWith(".json"));

const phone =
  /\+\d(?:[\s().-]*\d){7,14}(?!\d)|(?<![\p{L}\p{N}])(?:\(\d{3}\)|\d{3})[ .-]*\d{3}[ .-]*\d{4}(?![\p{L}\p{N}])/u;
const secret =
  /\b(sk-|rk-|Bearer\s+[A-Za-z0-9._\-]{16,}|AccountSid|AuthToken|xox[baprs]-)\b/i;

test("inbound SMS docs stay in this folder", () => {
  const present = new Set(readdirSync(dir));
  for (const name of listed) assert.ok(present.has(name), name);
});

test("inbound SMS docs do not contain phone numbers or secret-shaped strings", () => {
  for (const name of scanned) {
    const text = readFileSync(join(dir, name), "utf8");
    assert.equal(phone.test(text), false, `${name} has a phone number`);
    assert.equal(secret.test(text), false, `${name} has a secret-shaped string`);
  }
});
