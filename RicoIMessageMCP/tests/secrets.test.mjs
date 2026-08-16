import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureBearerTokenFile, readBearerToken, tokensMatch } from "../secrets.mjs";

test("bearer token file is created 0600 and the value is never required by the helper return", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rico-imessage-mcp-"));
  fs.chmodSync(root, 0o700);
  const tokenPath = path.join(root, "rico-imessage-mcp.token");
  const created = ensureBearerTokenFile(tokenPath);
  assert.equal(created.path, tokenPath);
  assert.equal(created.created, true);
  assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);
  const token = readBearerToken(tokenPath);
  assert.ok(token.length >= 32);
  assert.equal(tokensMatch(token, token), true);
  assert.equal(tokensMatch(token, "nope"), false);
  const again = ensureBearerTokenFile(tokenPath);
  assert.equal(again.created, false);
  assert.equal(readBearerToken(tokenPath), token);
});
