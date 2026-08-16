import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BadRudyWorkerError,
  CAPTURE_SOURCE,
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  MAX_PROMPT_LENGTH,
  REQUIRED_CAPABILITY,
  captureBadRudyClip,
  buildNormalizationArguments,
  dedupeKey,
  getWorkerStatus,
  loadGrokCredential,
  isFreshRenderCandidate,
  promptDigest,
  prepareArtifactDayForCapture,
  runOfflineSelfTest,
  type CaptureRequest,
} from "../index.ts";
import { GROK_COMPANIONS_SELECTORS } from "../selectors.ts";

function request(overrides: Partial<CaptureRequest> = {}): CaptureRequest {
  const prompt = overrides.prompt ?? "Say hello in one sentence.";
  return {
    prompt,
    requiredCapability: REQUIRED_CAPABILITY,
    governance: {
      killSwitch: false,
      dryRun: true,
      allowlistReady: true,
      rateLimitApproved: true,
      promptApproval: {
        approved: true,
        policyVersion: "studio-prompt-filter/v1",
        sha256: promptDigest(prompt),
      },
    },
    ...overrides,
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof BadRudyWorkerError);
    const workerError = error as BadRudyWorkerError;
    assert.equal(workerError.code, code);
    assert.doesNotMatch(workerError.message, /cookie|secret|token/i);
    return true;
  });
}

async function runCli(flag: "--capture" | "--selftest", input?: unknown): Promise<{
  argv: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  const workerPath = fileURLToPath(new URL("../index.ts", import.meta.url));
  const child = spawn(process.execPath, ["--experimental-strip-types", workerPath, flag], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  if (input === undefined) child.stdin.end();
  else child.stdin.end(JSON.stringify(input));
  const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", resolveExit);
  });
  return { argv: child.spawnargs, exitCode, stdout, stderr };
}

test("selector contract is centralized and exact for Companions and Bad Rudy", () => {
  assert.ok(GROK_COMPANIONS_SELECTORS.companionsNavigation.length > 0);
  assert.ok(GROK_COMPANIONS_SELECTORS.badRudyChoice.length > 0);
  assert.ok(
    GROK_COMPANIONS_SELECTORS.companionsNavigation.every((item) =>
      "name" in item && typeof item.name === "string" ? item.name === "Companions" : true,
    ),
  );
  assert.ok(
    GROK_COMPANIONS_SELECTORS.badRudyChoice.every((item) =>
      "name" in item && typeof item.name === "string" ? item.name === "Bad Rudy" : true,
    ),
  );
});

test("Keychain lookup uses only the fixed service and account", async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const credential = await loadGrokCredential(async (file, args) => {
    calls.push({ file, args });
    return {
      stdout: JSON.stringify({
        kind: "web_session",
        cookies: [{ name: "session", value: "top-secret", domain: ".grok.com", path: "/" }],
      }),
      stderr: "",
    };
  });

  assert.equal(credential.kind, "web_session");
  assert.deepEqual(calls, [
    {
      file: "/usr/bin/security",
      args: ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
    },
  ]);
});

test("invalid, missing, and API-key Keychain values fail closed", async () => {
  await expectCode(
    loadGrokCredential(async () => ({ stdout: "", stderr: "" })),
    "grok_keychain_missing",
  );
  await expectCode(
    loadGrokCredential(async () => ({ stdout: "not-json", stderr: "" })),
    "grok_keychain_value_invalid",
  );
  await expectCode(
    loadGrokCredential(async () => ({ stdout: JSON.stringify({ kind: "xai_api_key", apiKey: "xai-secret" }), stderr: "" })),
    "grok_bad_rudy_api_unavailable",
  );
});

test("credential bundles cannot target an unrelated domain", async () => {
  await expectCode(
    loadGrokCredential(async () => ({
      stdout: JSON.stringify({
        cookies: [{ name: "session", value: "secret", domain: ".example.com", path: "/" }],
      }),
      stderr: "",
    })),
    "grok_keychain_value_invalid",
  );
});

test("prompt approval is cryptographically bound to the exact prompt", async () => {
  const changed = request({ prompt: "Changed after approval" });
  changed.governance.promptApproval.sha256 = promptDigest("Original prompt");
  await expectCode(captureBadRudyClip(changed), "prompt_policy_denied");
});

test("hard cap, allowlist, kill switch, and rate policy fail closed", async () => {
  const tooLong = "x".repeat(MAX_PROMPT_LENGTH + 1);
  await expectCode(captureBadRudyClip(request({ prompt: tooLong })), "prompt_too_long");

  const emptyAllowlist = request();
  emptyAllowlist.governance.allowlistReady = false;
  await expectCode(captureBadRudyClip(emptyAllowlist), "allowlist_empty");

  const killed = request();
  killed.governance.killSwitch = true;
  await expectCode(captureBadRudyClip(killed), "kill_switch_enabled");

  const rateDenied = request();
  rateDenied.governance.rateLimitApproved = false;
  await expectCode(captureBadRudyClip(rateDenied), "rate_limit_denied");
});

test("capture requires the exact Bad Rudy capability", async () => {
  const wrongCapability = request();
  (wrongCapability as { requiredCapability: string }).requiredCapability = "grok:video";
  await expectCode(captureBadRudyClip(wrongCapability), "required_capability_invalid");
});

test("captured clips cannot recursively trigger capture", async () => {
  await expectCode(captureBadRudyClip(request({ source: CAPTURE_SOURCE })), "capture_loop_suppressed");
});

test("prompt + minute bucket drives capture-level dedupe", () => {
  const first = new Date("2026-08-15T15:30:05.000Z");
  const sameMinute = new Date("2026-08-15T15:30:59.000Z");
  const nextMinute = new Date("2026-08-15T15:31:00.000Z");
  assert.equal(
    dedupeKey("hello", first),
    dedupeKey("hello", sameMinute),
  );
  assert.notEqual(
    dedupeKey("hello", first),
    dedupeKey("hello", nextMinute),
  );
});

test("unsupported web capability causes no command, browser, or filesystem side effect", async () => {
  const tempParent = await mkdtemp(join(tmpdir(), "bad-rudy-test-"));
  const artifactRoot = join(tempParent, "artifacts");
  let commandCalls = 0;
  let browserLoads = 0;
  try {
    await expectCode(
      captureBadRudyClip(request(), {
        artifactRoot,
        command: async () => {
          commandCalls += 1;
          throw new Error("must not execute");
        },
        playwrightLoader: async () => {
          browserLoads += 1;
          throw new Error("must not load");
        },
      }),
      "grok_companions_web_unavailable",
    );
    assert.equal(commandCalls, 0);
    assert.equal(browserLoads, 0);
    await assert.rejects(access(artifactRoot));
  } finally {
    await rm(tempParent, { recursive: true, force: true });
  }
});

test("status never claims capture health while web capability is unverified", async () => {
  const status = await getWorkerStatus(
    { killSwitch: false, dryRun: true, allowlistReady: true },
    {
      command: async (file) => {
        if (file === "/usr/bin/security") {
          return {
            stdout: JSON.stringify({
              cookies: [{ name: "session", value: "top-secret", domain: ".grok.com", path: "/" }],
            }),
            stderr: "",
          };
        }
        throw new Error("unexpected command");
      },
      playwrightLoader: async () => ({
        chromium: {
          executablePath: () => "/bin/sh",
          launch: async () => {
            throw new Error("not used");
          },
        },
      }),
    },
  );
  assert.equal(status.keychain, "ok");
  assert.equal(status.playwright, "ready");
  assert.equal(status.ready, false);
  assert.equal(status.capabilities[REQUIRED_CAPABILITY], false);
  assert.equal(status.healthyForCapture, false);
  assert.equal(status.code, "grok_companions_web_unavailable");
  assert.doesNotMatch(JSON.stringify(status), /top-secret/);
});

test("offline selftest makes zero network calls and reports runtime capture skipped", async () => {
  const result = await runOfflineSelfTest();
  assert.equal(result.ok, true);
  assert.equal(result.mode, "offline");
  assert.equal(result.networkCalls, 0);
  assert.deepEqual(result.checks.at(-1), {
    step: "runtime_capture",
    status: "skipped",
    code: "grok_companions_web_unavailable",
  });
});

test("capture CLI receives prompt only over stdin and never echoes it on failure", async () => {
  const secretLookingPrompt = "authorization: Bearer should-never-appear";
  const result = await runCli("--capture", request({ prompt: secretLookingPrompt }));
  assert.equal(result.exitCode, 1);
  assert.ok(result.argv.every((argument) => !argument.includes(secretLookingPrompt)));
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /should-never-appear/);
  assert.deepEqual(JSON.parse(result.stderr), {
    error: "grok_companions_web_unavailable",
    step: "preflight",
    retryable: false,
  });
});

test("selftest CLI is offline and emits only its normalized report", async () => {
  const result = await runCli("--selftest");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout) as { ok: boolean; networkCalls: number; mode: string };
  assert.deepEqual(report, { ...report, ok: true, networkCalls: 0, mode: "offline" });
});

test("artifact boundary rejects a symlinked YYYY-MM-DD directory", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "bad-rudy-symlink-day-"));
  const canonicalTemporary = await realpath(temporary);
  const artifactRoot = join(canonicalTemporary, "bad-rudy");
  const outside = join(canonicalTemporary, "outside");
  await mkdir(artifactRoot, { mode: 0o700 });
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, join(artifactRoot, "2026-08-15"), "dir");
  try {
    await expectCode(
      prepareArtifactDayForCapture(artifactRoot, new Date("2026-08-15T15:30:00.000Z")),
      "artifact_symlink_forbidden",
    );
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(canonicalTemporary, { recursive: true, force: true });
  }
});

test("artifact boundary rejects a symlink anywhere above the artifact root", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "bad-rudy-symlink-parent-"));
  const canonicalTemporary = await realpath(temporary);
  const outside = join(canonicalTemporary, "outside");
  const linkedParent = join(canonicalTemporary, "linked-parent");
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, linkedParent, "dir");
  try {
    await expectCode(
      prepareArtifactDayForCapture(
        join(linkedParent, "bad-rudy"),
        new Date("2026-08-15T15:30:00.000Z"),
      ),
      "artifact_symlink_forbidden",
    );
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(canonicalTemporary, { recursive: true, force: true });
  }
});

test("artifact boundary requires private owner-only modes on managed directories", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "bad-rudy-mode-"));
  const canonicalTemporary = await realpath(temporary);
  const artifactRoot = join(canonicalTemporary, "bad-rudy");
  const dayRoot = join(artifactRoot, "2026-08-15");
  await mkdir(artifactRoot, { mode: 0o700 });
  await mkdir(dayRoot, { mode: 0o700 });
  await chmod(dayRoot, 0o755);
  try {
    await expectCode(
      prepareArtifactDayForCapture(artifactRoot, new Date("2026-08-15T15:30:00.000Z")),
      "artifact_mode_invalid",
    );
  } finally {
    await rm(canonicalTemporary, { recursive: true, force: true });
  }
});

test("render binding rejects a stale pre-submit video", () => {
  const baseline = { marker: "job-pre-submit", src: "blob:old", hadVideo: true };
  assert.equal(
    isFreshRenderCandidate(
      baseline,
      { marker: "job-pre-submit", src: "blob:old", ready: true },
      false,
    ),
    false,
  );
  assert.equal(
    isFreshRenderCandidate(
      baseline,
      { marker: "job-pre-submit", src: "blob:new", ready: true },
      false,
    ),
    true,
  );
  assert.equal(
    isFreshRenderCandidate(
      baseline,
      { marker: "job-pre-submit", src: "blob:old", ready: true },
      true,
    ),
    true,
  );
});

test("fallback normalization seeks to the post-render playback segment", () => {
  const args = buildNormalizationArguments(
    "/private/input.webm",
    "/private/output.mp4",
    20,
    { x: 10, y: 20, width: 640, height: 360 },
    12.3456,
  );
  assert.equal(args.includes("-y"), false);
  assert.ok(args.includes("-n"));
  assert.equal(args[args.indexOf("-ss") + 1], "12.346");
  assert.ok(args.indexOf("-ss") < args.indexOf("-i"));
  assert.match(args[args.indexOf("-vf") + 1]!, /^crop=/);
});
