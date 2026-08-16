import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AutomaticIMTRequestRegistry,
  automaticIMTIdempotencyKey,
  automaticIMTRequestId,
} from "../automatic-imt.mjs";

const NOW = Date.parse("2026-08-15T20:00:00.000Z");

async function fixture() {
  const temporaryRoot = await fs.promises.realpath(os.tmpdir());
  const directory = await fs.promises.mkdtemp(path.join(temporaryRoot, "rico-imt-registry-"));
  await fs.promises.chmod(directory, 0o700);
  const filePath = path.join(directory, "state.json");
  return { directory, filePath };
}

async function cleanup(directory) {
  const temporaryRoot = await fs.promises.realpath(os.tmpdir());
  if (directory.startsWith(`${temporaryRoot}${path.sep}`)) {
    await fs.promises.rm(directory, { recursive: true, force: false });
  }
}

function registry(fixtureValue) {
  return new AutomaticIMTRequestRegistry({
    filePath: fixtureValue.filePath,
    supportDirectory: fixtureValue.directory,
    now: () => NOW,
    allowTestDirectory: true,
  });
}

function identity(index = 0, timestamp = NOW) {
  return automaticIMTIdempotencyKey({
    conversation: "chat_id:42",
    sender: "+15550000002",
    timestamp,
    content: `@rico what is IMT seeing right now for service ${index}?`,
  });
}

function claimInput(index = 0, timestamp = NOW, overrides = {}) {
  const value = identity(index, timestamp);
  const audienceScope = overrides.audienceScope ?? "b".repeat(64);
  return {
    eventKey: value.eventKey,
    dedupeKey: value.dedupeKey,
    audienceFingerprint: overrides.audienceFingerprint ?? "a".repeat(64),
    audienceScope,
    requestId: automaticIMTRequestId({ eventKey: value.eventKey, audienceScope, timestamp }),
    at: new Date(timestamp),
  };
}

test("reservation is durable, private, and resumes the exact submitted request after restart", async () => {
  const value = await fixture();
  try {
    const first = registry(value);
    const claimed = await first.claim(claimInput());
    assert.equal(claimed.disposition, "new");
    await first.markSubmitted({ eventKey: claimed.eventKey, requestId: claimed.requestId, at: new Date(NOW + 1) });

    const restarted = registry(value);
    assert.deepEqual(await restarted.claim(claimInput()), {
      disposition: "resume",
      eventKey: claimed.eventKey,
      requestId: claimed.requestId,
      audienceScope: "b".repeat(64),
    });
    assert.equal((await fs.promises.stat(value.directory)).mode & 0o777, 0o700);
    assert.equal((await fs.promises.stat(value.filePath)).mode & 0o777, 0o600);
    const persisted = JSON.parse(await fs.promises.readFile(value.filePath, "utf8"));
    assert.equal(persisted.entries.length, 1);
    assert.equal(persisted.entries[0].status, "submitted");
    assert.equal(JSON.stringify(persisted).includes("+1555"), false);
    assert.equal(JSON.stringify(persisted).includes("what is IMT"), false);
  } finally {
    await cleanup(value.directory);
  }
});

test("reserved event recovers its exact deterministic request and terminal event is silent duplicate", async () => {
  const value = await fixture();
  try {
    const instance = registry(value);
    const input = claimInput();
    const first = await instance.claim(input);
    assert.deepEqual(await instance.claim(input), {
      disposition: "recover",
      eventKey: first.eventKey,
      requestId: first.requestId,
      audienceScope: first.audienceScope,
    });
    await instance.markTerminal({ eventKey: first.eventKey, outcome: "failed", at: new Date(NOW + 1) });
    assert.equal((await instance.claim(input)).disposition, "duplicate");
  } finally {
    await cleanup(value.directory);
  }
});

test("same-minute but different event is a duplicate and cannot resume the first request", async () => {
  const value = await fixture();
  try {
    const instance = registry(value);
    const first = await instance.claim(claimInput(0, NOW));
    await instance.markSubmitted({ eventKey: first.eventKey, requestId: first.requestId, at: new Date(NOW + 1) });
    const second = await instance.claim(claimInput(0, NOW + 500));
    assert.equal(second.disposition, "duplicate");
    assert.equal(second.eventKey, first.eventKey);
  } finally {
    await cleanup(value.directory);
  }
});

test("per-audience rate limit is durable across registry instances", async () => {
  const value = await fixture();
  try {
    for (let index = 0; index < 3; index += 1) {
      assert.equal((await registry(value).claim(claimInput(index))).disposition, "new");
    }
    const limited = claimInput(4);
    assert.equal((await registry(value).claim(limited)).disposition, "rate_limited");
    assert.equal((await registry(value).claim(limited)).disposition, "duplicate");
  } finally {
    await cleanup(value.directory);
  }
});

test("global rate limit applies across distinct audience fingerprints", async () => {
  const value = await fixture();
  try {
    for (let index = 0; index < 10; index += 1) {
      const fingerprint = (index + 1).toString(16).padStart(64, "0");
      const scope = (index + 101).toString(16).padStart(64, "0");
      assert.equal((await registry(value).claim(claimInput(index, NOW, {
        audienceFingerprint: fingerprint,
        audienceScope: scope,
      }))).disposition, "new");
    }
    assert.equal((await registry(value).claim(claimInput(11, NOW, {
      audienceFingerprint: "f".repeat(64),
      audienceScope: "e".repeat(64),
    }))).disposition, "rate_limited");
  } finally {
    await cleanup(value.directory);
  }
});

test("concurrent registry instances serialize into one valid state file without lost entries", async () => {
  const value = await fixture();
  try {
    const results = await Promise.all([0, 1, 2].map((index) => registry(value).claim(claimInput(index))));
    assert.deepEqual(results.map((item) => item.disposition), ["new", "new", "new"]);
    const persisted = JSON.parse(await fs.promises.readFile(value.filePath, "utf8"));
    assert.equal(persisted.entries.length, 3);
    assert.equal(new Set(persisted.entries.map((entry) => entry.eventKey)).size, 3);
  } finally {
    await cleanup(value.directory);
  }
});

test("same event with changed audience generation is quarantined rather than resumed", async () => {
  const value = await fixture();
  try {
    const instance = registry(value);
    const first = claimInput();
    assert.equal((await instance.claim(first)).disposition, "new");
    const changed = claimInput(0, NOW, {
      audienceFingerprint: "c".repeat(64),
      audienceScope: "d".repeat(64),
    });
    assert.equal((await instance.claim(changed)).disposition, "quarantined");
    const persisted = JSON.parse(await fs.promises.readFile(value.filePath, "utf8"));
    assert.equal(persisted.entries[0].status, "terminal");
    assert.equal(persisted.entries[0].outcome, "failed");
  } finally {
    await cleanup(value.directory);
  }
});

test("an explicit production allowedRoot remains bounded to the exact private support directory", async () => {
  const value = await fixture();
  try {
    const instance = new AutomaticIMTRequestRegistry({
      filePath: value.filePath,
      supportDirectory: value.directory,
      allowedRoot: value.directory,
      now: () => NOW,
    });
    assert.equal((await instance.claim(claimInput())).disposition, "new");
    assert.throws(() => new AutomaticIMTRequestRegistry({
      filePath: value.filePath,
      supportDirectory: value.directory,
      allowedRoot: path.dirname(value.directory),
    }), /registry_config_invalid/u);
  } finally {
    await cleanup(value.directory);
  }
});

test("unsafe state file mode and symlink destination fail closed", async () => {
  const modeValue = await fixture();
  const linkValue = await fixture();
  try {
    await fs.promises.writeFile(modeValue.filePath, '{"schemaVersion":1,"entries":[]}\n', { mode: 0o644 });
    await assert.rejects(() => registry(modeValue).claim(claimInput()), /state_file_unsafe/u);

    const external = path.join(linkValue.directory, "external.json");
    await fs.promises.writeFile(external, '{"schemaVersion":1,"entries":[]}\n', { mode: 0o600 });
    await fs.promises.symlink(external, linkValue.filePath);
    await assert.rejects(() => registry(linkValue).claim(claimInput()), /state_file_unsafe/u);
  } finally {
    await cleanup(modeValue.directory);
    await cleanup(linkValue.directory);
  }
});

test("idempotency rejects missing trusted timestamp and never stores raw event fields", () => {
  assert.throws(() => automaticIMTIdempotencyKey({
    conversation: "chat_id:42", sender: "+15550000002", content: "@rico what is IMT seeing?",
  }), /timestamp_invalid/u);
  const value = identity();
  assert.deepEqual(Object.keys(value).sort(), ["dedupeKey", "eventKey", "timestampMs"]);
  assert.match(value.eventKey, /^[a-f0-9]{64}$/u);
  assert.match(value.dedupeKey, /^[a-f0-9]{64}$/u);
  assert.notEqual(
    automaticIMTRequestId({ eventKey: value.eventKey, audienceScope: "b".repeat(64), timestamp: NOW }),
    automaticIMTRequestId({ eventKey: value.eventKey, audienceScope: "c".repeat(64), timestamp: NOW }),
  );
});
