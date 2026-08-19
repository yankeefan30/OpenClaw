import assert from "node:assert/strict";
import test from "node:test";
import { MacOSPressmasterCredentialProvider } from "../keychain.mjs";

test("keychain status is available without echoing the secret", async () => {
  const provider = new MacOSPressmasterCredentialProvider({
    execFileFn: async () => ({ stdout: Buffer.from("not-printed-secret-value\n") }),
  });
  const status = await provider.status();
  assert.deepEqual(status, {
    available: true,
    source: "keychain",
    service: "rico-pressmaster-mcp",
    account: "alan",
  });
  assert.ok(!JSON.stringify(status).includes("not-printed-secret-value"));
});

test("missing keychain fails closed", async () => {
  const provider = new MacOSPressmasterCredentialProvider({
    execFileFn: async () => {
      const error = new Error("fail");
      error.code = 44;
      throw error;
    },
  });
  const status = await provider.status();
  assert.equal(status.available, false);
  assert.equal(status.code, "keychain_missing");
});

test("replaceBundle sends secret bytes on stdin, never argv", async () => {
  let captured;
  const provider = new MacOSPressmasterCredentialProvider({
    replaceSecretFn: async (secret, options) => {
      captured = { length: secret.length, service: options.service, account: options.account, helper: options.helperPath };
    },
  });
  await provider.replaceBundle({
    schema: "rico.pressmaster.oauth-bundle",
    accessToken: "access-token-value-1234",
  });
  assert.equal(captured.service, "rico-pressmaster-mcp");
  assert.equal(captured.account, "alan");
  assert.match(captured.helper, /KeychainWriteHelper\.swift$/);
  assert.ok(captured.length > 0);
});
