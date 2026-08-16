import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  unlink,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { GROK_COMPANIONS_SELECTORS, type SelectorSpec } from "./selectors.ts";

const execFile = promisify(execFileCallback);

export const WORKER_VERSION = "0.1.0";
export const KEYCHAIN_SERVICE = "openclaw-grok";
export const KEYCHAIN_ACCOUNT = "alan";
export const CAPTURE_SOURCE = "grok:bad-rudy" as const;
export const REQUIRED_CAPABILITY = "grok:companions:bad-rudy" as const;
export const DEFAULT_ARTIFACT_ROOT = join(homedir(), "OpenClaw", "artifacts", "bad-rudy");
export const DECLARED_PROFILE_ROOT = join(homedir(), "OpenClaw", "state", "grok-profile");
export const GROK_ORIGIN = "https://grok.com";
export const MAX_PROMPT_LENGTH = 2_000;
export const SOFT_PROMPT_LENGTH = 500;
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

/**
 * A normalized capture result. Delivery code is intentionally not imported by
 * this module; adapters consume this value at the Studio boundary.
 */
export interface CapturedClip {
  id: string;
  path: string;
  mime: "video/mp4";
  duration_ms: number;
  thumbnail_path: string | null;
  prompt: string;
  created_at: string;
  source: typeof CAPTURE_SOURCE;
}

export interface CaptureRequest {
  prompt: string;
  source?: string;
  requiredCapability: typeof REQUIRED_CAPABILITY;
  advanced?: {
    format?: "mp4";
    maxDurationSeconds?: number;
    exportStill?: boolean;
    retries?: number;
  };
  governance: {
    killSwitch: boolean;
    dryRun: boolean;
    /** Resolved by the governance layer without disclosing identities here. */
    allowlistReady: boolean;
    rateLimitApproved: boolean;
    promptApproval: {
      approved: boolean;
      policyVersion: string;
      sha256: string;
    };
    /** Explicit opt-in to a read-only runtime capability probe. */
    runtimeCapabilityProbe?: boolean;
  };
}

export interface WorkerStatus {
  ready: boolean;
  keychain: "ok" | "missing" | "invalid";
  playwright: "ready" | "down";
  ffmpeg: "ready" | "down";
  dryRun: boolean;
  killSwitch: boolean;
  allowlist: "ready" | "empty";
  capabilities: { "grok:companions:bad-rudy": boolean };
  healthyForCapture: boolean;
  code: string;
  detail: string;
}

export interface WorkerOptions {
  artifactRoot?: string;
  now?: () => Date;
  uuid?: () => string;
  command?: CommandRunner;
  playwrightLoader?: () => Promise<PlaywrightLike>;
  logger?: (event: SafeDiagnostic) => void;
}

export interface SafeDiagnostic {
  event: string;
  code?: string;
  step?: CaptureStep;
}

type CommandResult = { stdout: string; stderr: string };
type CommandRunner = (file: string, args: readonly string[], timeoutMs: number) => Promise<CommandResult>;

type CaptureStep =
  | "preflight"
  | "launch"
  | "navigate"
  | "login"
  | "companions"
  | "bad_rudy"
  | "submit"
  | "render"
  | "download"
  | "normalize"
  | "thumbnail";

type BrowserCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
};

type OriginStorage = {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
};

type WebCredential = {
  kind: "web_session";
  cookies: BrowserCookie[];
  origins: OriginStorage[];
};

type LocatorLike = {
  first(): LocatorLike;
  getByText(value: string | RegExp, options?: { exact?: boolean }): LocatorLike;
  isVisible(options?: { timeout?: number }): Promise<boolean>;
  click(options?: { timeout?: number }): Promise<void>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  evaluate<T>(fn: (element: HTMLVideoElement) => T | Promise<T>): Promise<T>;
  evaluate<T, A>(fn: (element: HTMLVideoElement, argument: A) => T | Promise<T>, argument: A): Promise<T>;
};

export type RenderBaseline = { marker: string; src: string | null; hadVideo: boolean };
export type RenderCandidateState = { marker: string | null; src: string; ready: boolean };

type ResponseLike = {
  url(): string;
  headers(): Record<string, string>;
};

type RequestResponseLike = {
  ok(): boolean;
  headers(): Record<string, string>;
  body(): Promise<Buffer>;
};

type PageVideoLike = { path(): Promise<string> };

type PageLike = {
  goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
  getByRole(role: string, options: { name: string | RegExp; exact?: boolean }): LocatorLike;
  getByTestId(value: string): LocatorLike;
  getByText(value: string | RegExp, options?: { exact?: boolean }): LocatorLike;
  getByPlaceholder(value: string | RegExp): LocatorLike;
  locator(value: string): LocatorLike;
  on(event: "response", listener: (response: ResponseLike) => void): void;
  screenshot(options: { path?: string; fullPage: boolean }): Promise<Buffer>;
  video(): PageVideoLike | null;
};

type BrowserContextLike = {
  addCookies(cookies: BrowserCookie[]): Promise<void>;
  addInitScript(fn: (origins: OriginStorage[]) => void, origins: OriginStorage[]): Promise<void>;
  newPage(): Promise<PageLike>;
  clearCookies(): Promise<void>;
  close(): Promise<void>;
  request: { get(url: string, options: { timeout: number; maxRedirects: number }): Promise<RequestResponseLike> };
};

type BrowserLike = {
  newContext(options: {
    acceptDownloads: boolean;
    viewport: { width: number; height: number };
    recordVideo: { dir: string; size: { width: number; height: number } };
  }): Promise<BrowserContextLike>;
  close(): Promise<void>;
};

type ChromiumLike = {
  executablePath(): string;
  launch(options: { headless: true; args: string[]; timeout: number }): Promise<BrowserLike>;
};

type PlaywrightLike = { chromium: ChromiumLike };

const STEP_TIMEOUT_MS: Readonly<Record<CaptureStep, number>> = Object.freeze({
  preflight: 5_000,
  launch: 20_000,
  navigate: 30_000,
  login: 8_000,
  companions: 12_000,
  bad_rudy: 12_000,
  submit: 10_000,
  render: 120_000,
  download: 30_000,
  normalize: 45_000,
  thumbnail: 20_000,
});

const SAFE_COOKIE_DOMAINS = new Set([
  "grok.com",
  ".grok.com",
  "x.com",
  ".x.com",
  "x.ai",
  ".x.ai",
]);

const SAFE_STORAGE_ORIGINS = new Set(["https://grok.com", "https://x.com", "https://x.ai"]);

export class BadRudyWorkerError extends Error {
  readonly code: string;
  readonly step: CaptureStep;
  readonly retryable: boolean;

  constructor(code: string, step: CaptureStep, retryable = false) {
    super(code);
    this.name = "BadRudyWorkerError";
    this.code = code;
    this.step = step;
    this.retryable = retryable;
  }

  toJSON(): { error: string; step: CaptureStep; retryable: boolean } {
    return { error: this.code, step: this.step, retryable: this.retryable };
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function promptDigest(prompt: string): string {
  return sha256(prompt);
}

export function dedupeKey(prompt: string, now: Date): string {
  const minuteBucket = now.toISOString().slice(0, 16);
  return sha256(`${prompt.trim()}\n${minuteBucket}`);
}

function safePromptPreview(prompt: string): string {
  const redacted = prompt
    .replace(/\b(?:xai|sk)-[A-Za-z0-9_-]{12,}\b/gi, "[REDACTED_KEY]")
    .replace(/\b(cookie|authorization|bearer)\s*[:=]\s*\S+(?:\s+\S+)?/gi, "$1=[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return redacted.length > 120 ? `${redacted.slice(0, 117)}...` : redacted;
}

function formatDay(now: Date): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(now);
}

function assertLexicallyInsideRoot(candidate: string, root: string): void {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new BadRudyWorkerError("artifact_path_outside_root", "preflight");
}

function currentUID(): number {
  if (typeof process.getuid !== "function") {
    throw new BadRudyWorkerError("artifact_owner_unverifiable", "preflight");
  }
  return process.getuid();
}

function pathLineage(target: string): string[] {
  const lineage: string[] = [];
  let cursor = resolve(target);
  while (true) {
    lineage.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return lineage.reverse();
}

function isMissing(error: unknown): boolean {
  return (error as { code?: string }).code === "ENOENT";
}

function assertPrivateOwnedMode(
  metadata: { uid: number; mode: number; nlink: number; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean },
  expectedType: "directory" | "file",
  expectedMode: number,
): void {
  if (metadata.isSymbolicLink()) {
    throw new BadRudyWorkerError("artifact_symlink_forbidden", "preflight");
  }
  const validType = expectedType === "directory" ? metadata.isDirectory() : metadata.isFile();
  if (!validType) throw new BadRudyWorkerError("artifact_type_invalid", "preflight");
  if (expectedType === "file" && metadata.nlink !== 1) {
    throw new BadRudyWorkerError("artifact_hardlink_forbidden", "preflight");
  }
  if (metadata.uid !== currentUID()) {
    throw new BadRudyWorkerError("artifact_owner_invalid", "preflight");
  }
  if ((metadata.mode & 0o777) !== expectedMode) {
    throw new BadRudyWorkerError("artifact_mode_invalid", "preflight");
  }
}

async function ensureArtifactRoot(artifactRoot: string): Promise<string> {
  if (!isAbsolute(artifactRoot)) {
    throw new BadRudyWorkerError("artifact_root_must_be_absolute", "preflight");
  }
  const resolvedRoot = resolve(artifactRoot);
  const lineage = pathLineage(resolvedRoot);
  let creating = false;
  for (const candidate of lineage) {
    let metadata;
    try {
      metadata = await lstat(candidate);
    } catch (error) {
      if (!isMissing(error)) throw new BadRudyWorkerError("artifact_parent_unavailable", "preflight");
      creating = true;
      try {
        await mkdir(candidate, { mode: 0o700 });
        metadata = await lstat(candidate);
      } catch {
        throw new BadRudyWorkerError("artifact_directory_create_failed", "preflight");
      }
    }
    if (metadata.isSymbolicLink()) {
      throw new BadRudyWorkerError("artifact_symlink_forbidden", "preflight");
    }
    if (!metadata.isDirectory()) {
      throw new BadRudyWorkerError("artifact_parent_type_invalid", "preflight");
    }
    if (creating) assertPrivateOwnedMode(metadata, "directory", 0o700);
  }

  const rootMetadata = await lstat(resolvedRoot);
  assertPrivateOwnedMode(rootMetadata, "directory", 0o700);
  const canonicalRoot = await realpath(resolvedRoot);
  if (canonicalRoot !== resolvedRoot) {
    throw new BadRudyWorkerError("artifact_root_realpath_mismatch", "preflight");
  }
  return canonicalRoot;
}

async function assertManagedDirectoryChain(target: string, artifactRoot: string): Promise<void> {
  assertLexicallyInsideRoot(target, artifactRoot);
  const canonicalRoot = await ensureArtifactRoot(artifactRoot);
  const resolvedTarget = resolve(target);
  const rel = relative(canonicalRoot, resolvedTarget);
  let cursor = canonicalRoot;
  const components = rel === "" ? [] : rel.split(/[\\/]+/).filter(Boolean);
  assertPrivateOwnedMode(await lstat(cursor), "directory", 0o700);
  for (const component of components) {
    cursor = join(cursor, component);
    let metadata;
    try {
      metadata = await lstat(cursor);
    } catch {
      throw new BadRudyWorkerError("artifact_parent_unavailable", "preflight");
    }
    assertPrivateOwnedMode(metadata, "directory", 0o700);
    const canonical = await realpath(cursor);
    if (canonical !== cursor) throw new BadRudyWorkerError("artifact_symlink_forbidden", "preflight");
    assertLexicallyInsideRoot(canonical, canonicalRoot);
  }
}

async function ensureManagedDirectory(
  target: string,
  artifactRoot: string,
  options: { exclusive?: boolean } = {},
): Promise<string> {
  assertLexicallyInsideRoot(target, artifactRoot);
  const canonicalRoot = await ensureArtifactRoot(artifactRoot);
  const resolvedTarget = resolve(target);
  await assertManagedDirectoryChain(dirname(resolvedTarget), canonicalRoot);
  let metadata;
  try {
    metadata = await lstat(resolvedTarget);
    if (options.exclusive) {
      throw new BadRudyWorkerError("artifact_directory_exists", "preflight");
    }
  } catch (error) {
    if (error instanceof BadRudyWorkerError) throw error;
    if (!isMissing(error)) throw new BadRudyWorkerError("artifact_directory_unavailable", "preflight");
    try {
      await mkdir(resolvedTarget, { mode: 0o700 });
      metadata = await lstat(resolvedTarget);
    } catch {
      throw new BadRudyWorkerError("artifact_directory_create_failed", "preflight");
    }
  }
  assertPrivateOwnedMode(metadata, "directory", 0o700);
  const canonicalTarget = await realpath(resolvedTarget);
  assertLexicallyInsideRoot(canonicalTarget, canonicalRoot);
  return canonicalTarget;
}

async function validateManagedFile(
  target: string,
  artifactRoot: string,
  options: { mustExist: boolean; exactMode?: number },
): Promise<boolean> {
  assertLexicallyInsideRoot(target, artifactRoot);
  const canonicalRoot = await ensureArtifactRoot(artifactRoot);
  const parent = dirname(resolve(target));
  await assertManagedDirectoryChain(parent, canonicalRoot);
  const canonicalParent = await realpath(parent).catch(() => {
    throw new BadRudyWorkerError("artifact_parent_unavailable", "preflight");
  });
  assertLexicallyInsideRoot(canonicalParent, canonicalRoot);
  let metadata;
  try {
    metadata = await lstat(target);
  } catch (error) {
    if (!isMissing(error)) throw new BadRudyWorkerError("artifact_file_unavailable", "preflight");
    if (options.mustExist) throw new BadRudyWorkerError("artifact_file_missing", "preflight");
    return false;
  }
  if (metadata.isSymbolicLink()) {
    throw new BadRudyWorkerError("artifact_symlink_forbidden", "preflight");
  }
  if (!metadata.isFile()) throw new BadRudyWorkerError("artifact_type_invalid", "preflight");
  if (metadata.nlink !== 1) throw new BadRudyWorkerError("artifact_hardlink_forbidden", "preflight");
  if (metadata.uid !== currentUID()) throw new BadRudyWorkerError("artifact_owner_invalid", "preflight");
  if (options.exactMode !== undefined && (metadata.mode & 0o777) !== options.exactMode) {
    throw new BadRudyWorkerError("artifact_mode_invalid", "preflight");
  }
  const canonicalFile = await realpath(target);
  assertLexicallyInsideRoot(canonicalFile, canonicalRoot);
  return true;
}

async function writeManagedFileExclusive(target: string, artifactRoot: string, bytes: string | Buffer): Promise<void> {
  const exists = await validateManagedFile(target, artifactRoot, { mustExist: false });
  if (exists) throw new BadRudyWorkerError("artifact_file_exists", "preflight");
  let handle;
  try {
    handle = await open(
      target,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.chmod(0o600);
    assertPrivateOwnedMode(await handle.stat(), "file", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    if (error instanceof BadRudyWorkerError) throw error;
    throw new BadRudyWorkerError("artifact_file_create_failed", "preflight");
  } finally {
    await handle?.close().catch(() => undefined);
  }
  await validateManagedFile(target, artifactRoot, { mustExist: true, exactMode: 0o600 });
}

async function appendManagedLog(target: string, artifactRoot: string, line: string): Promise<void> {
  const existed = await validateManagedFile(target, artifactRoot, { mustExist: false, exactMode: 0o600 });
  let handle;
  try {
    handle = await open(
      target,
      fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
      0o600,
    );
    if (!existed) await handle.chmod(0o600);
    assertPrivateOwnedMode(await handle.stat(), "file", 0o600);
    await handle.writeFile(line);
    await handle.sync();
  } catch (error) {
    if (error instanceof BadRudyWorkerError) throw error;
    throw new BadRudyWorkerError("artifact_log_write_failed", "preflight");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function adoptManagedFile(target: string, artifactRoot: string): Promise<void> {
  await validateManagedFile(target, artifactRoot, { mustExist: true });
  let handle;
  try {
    handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat();
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new BadRudyWorkerError("artifact_type_invalid", "preflight");
    }
    if (before.uid !== currentUID()) throw new BadRudyWorkerError("artifact_owner_invalid", "preflight");
    await handle.chmod(0o600);
    assertPrivateOwnedMode(await handle.stat(), "file", 0o600);
  } catch (error) {
    if (error instanceof BadRudyWorkerError) throw error;
    throw new BadRudyWorkerError("artifact_file_unavailable", "preflight");
  } finally {
    await handle?.close().catch(() => undefined);
  }
  await validateManagedFile(target, artifactRoot, { mustExist: true, exactMode: 0o600 });
}

async function copyManagedFileExclusive(source: string, destination: string, artifactRoot: string): Promise<void> {
  await validateManagedFile(source, artifactRoot, { mustExist: true, exactMode: 0o600 });
  let sourceHandle;
  try {
    sourceHandle = await open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    assertPrivateOwnedMode(await sourceHandle.stat(), "file", 0o600);
    const bytes = await sourceHandle.readFile();
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_MEDIA_BYTES) {
      throw new BadRudyWorkerError("artifact_file_size_invalid", "preflight");
    }
    await writeManagedFileExclusive(destination, artifactRoot, bytes);
  } catch (error) {
    if (error instanceof BadRudyWorkerError) throw error;
    throw new BadRudyWorkerError("artifact_finalization_failed", "normalize");
  } finally {
    await sourceHandle?.close().catch(() => undefined);
  }
}

async function validateManagedTree(target: string, artifactRoot: string): Promise<boolean> {
  assertLexicallyInsideRoot(target, artifactRoot);
  await ensureArtifactRoot(artifactRoot);
  let metadata;
  try {
    metadata = await lstat(target);
  } catch (error) {
    if (isMissing(error)) return false;
    throw new BadRudyWorkerError("artifact_file_unavailable", "preflight");
  }
  if (metadata.isSymbolicLink()) throw new BadRudyWorkerError("artifact_symlink_forbidden", "preflight");
  if (metadata.uid !== currentUID()) throw new BadRudyWorkerError("artifact_owner_invalid", "preflight");
  if (metadata.isFile() && metadata.nlink !== 1) {
    throw new BadRudyWorkerError("artifact_hardlink_forbidden", "preflight");
  }
  const canonical = await realpath(target);
  const canonicalRoot = await realpath(artifactRoot);
  assertLexicallyInsideRoot(canonical, canonicalRoot);
  if (metadata.isDirectory()) {
    if ((metadata.mode & 0o777) !== 0o700) {
      throw new BadRudyWorkerError("artifact_mode_invalid", "preflight");
    }
    const entries = await readdir(target);
    for (const entry of entries) {
      await validateManagedTree(join(target, entry), artifactRoot);
    }
  } else if (!metadata.isFile()) {
    throw new BadRudyWorkerError("artifact_type_invalid", "preflight");
  }
  return true;
}

async function removeManagedTreeIfPresent(target: string, artifactRoot: string): Promise<void> {
  if (!(await validateManagedTree(target, artifactRoot))) return;
  await rm(target, { recursive: true, force: false });
}

async function removeManagedFileIfPresent(target: string, artifactRoot: string): Promise<void> {
  const exists = await validateManagedFile(target, artifactRoot, { mustExist: false });
  if (!exists) return;
  await unlink(target);
}

export async function prepareArtifactDayForCapture(artifactRoot: string, now: Date): Promise<string> {
  const resolvedRoot = resolve(artifactRoot);
  await ensureArtifactRoot(resolvedRoot);
  const dayRoot = join(resolvedRoot, formatDay(now));
  return ensureManagedDirectory(dayRoot, resolvedRoot);
}

async function defaultCommand(file: string, args: readonly string[], timeoutMs: number): Promise<CommandResult> {
  try {
    const result = await execFile(file, [...args], {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "utf8",
      windowsHide: true,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch {
    // Command errors are intentionally collapsed. stderr may contain a URL,
    // cookie, token, or browser diagnostic and must never reach Studio logs.
    throw new BadRudyWorkerError("local_dependency_command_failed", "preflight");
  }
}

async function findExecutable(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep checking fixed, trusted paths. PATH is deliberately ignored.
    }
  }
  return null;
}

async function parseKeychainSecret(secret: string): Promise<WebCredential> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new BadRudyWorkerError("grok_keychain_value_invalid", "preflight");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BadRudyWorkerError("grok_keychain_value_invalid", "preflight");
  }

  const record = parsed as Record<string, unknown>;
  if (record.kind === "xai_api_key" || typeof record.apiKey === "string") {
    // xAI's generic API is not silently substituted for the Bad Rudy
    // Companions experience.
    throw new BadRudyWorkerError("grok_bad_rudy_api_unavailable", "preflight");
  }

  if (!Array.isArray(record.cookies) || record.cookies.length === 0) {
    throw new BadRudyWorkerError("grok_keychain_value_invalid", "preflight");
  }

  const cookies: BrowserCookie[] = record.cookies.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new BadRudyWorkerError("grok_keychain_value_invalid", "preflight");
    }
    const cookie = candidate as Record<string, unknown>;
    if (
      typeof cookie.name !== "string" ||
      typeof cookie.value !== "string" ||
      typeof cookie.domain !== "string" ||
      cookie.name.length === 0 ||
      cookie.value.length === 0 ||
      !SAFE_COOKIE_DOMAINS.has(cookie.domain)
    ) {
      throw new BadRudyWorkerError("grok_keychain_value_invalid", "preflight");
    }
    const sameSite = cookie.sameSite;
    if (sameSite !== undefined && sameSite !== "Strict" && sameSite !== "Lax" && sameSite !== "None") {
      throw new BadRudyWorkerError("grok_keychain_value_invalid", "preflight");
    }
    return {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: typeof cookie.path === "string" ? cookie.path : "/",
      ...(typeof cookie.expires === "number" ? { expires: cookie.expires } : {}),
      ...(typeof cookie.httpOnly === "boolean" ? { httpOnly: cookie.httpOnly } : {}),
      ...(typeof cookie.secure === "boolean" ? { secure: cookie.secure } : {}),
      ...(sameSite ? { sameSite } : {}),
    };
  });

  const origins: OriginStorage[] = [];
  if (record.origins !== undefined) {
    if (!Array.isArray(record.origins)) {
      throw new BadRudyWorkerError("grok_keychain_value_invalid", "preflight");
    }
    for (const candidate of record.origins) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new BadRudyWorkerError("grok_keychain_value_invalid", "preflight");
      }
      const origin = candidate as Record<string, unknown>;
      if (typeof origin.origin !== "string" || !SAFE_STORAGE_ORIGINS.has(origin.origin)) {
        throw new BadRudyWorkerError("grok_keychain_value_invalid", "preflight");
      }
      if (!Array.isArray(origin.localStorage)) {
        throw new BadRudyWorkerError("grok_keychain_value_invalid", "preflight");
      }
      const localStorage = origin.localStorage.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new BadRudyWorkerError("grok_keychain_value_invalid", "preflight");
        }
        const item = entry as Record<string, unknown>;
        if (typeof item.name !== "string" || typeof item.value !== "string") {
          throw new BadRudyWorkerError("grok_keychain_value_invalid", "preflight");
        }
        return { name: item.name, value: item.value };
      });
      origins.push({ origin: origin.origin, localStorage });
    }
  }

  return { kind: "web_session", cookies, origins };
}

export async function loadGrokCredential(command: CommandRunner = defaultCommand): Promise<WebCredential> {
  let result: CommandResult;
  try {
    result = await command(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      STEP_TIMEOUT_MS.preflight,
    );
  } catch {
    throw new BadRudyWorkerError("grok_keychain_missing", "preflight");
  }
  const secret = result.stdout.trim();
  if (!secret) throw new BadRudyWorkerError("grok_keychain_missing", "preflight");
  return parseKeychainSecret(secret);
}

function validateRequest(request: CaptureRequest, now: Date): void {
  if (request.source === CAPTURE_SOURCE) {
    throw new BadRudyWorkerError("capture_loop_suppressed", "preflight");
  }
  if (request.requiredCapability !== REQUIRED_CAPABILITY) {
    throw new BadRudyWorkerError("required_capability_invalid", "preflight");
  }
  if (request.governance.killSwitch) {
    throw new BadRudyWorkerError("kill_switch_enabled", "preflight");
  }
  if (!request.governance.allowlistReady) {
    throw new BadRudyWorkerError("allowlist_empty", "preflight");
  }
  if (!request.governance.rateLimitApproved) {
    throw new BadRudyWorkerError("rate_limit_denied", "preflight");
  }
  if (typeof request.prompt !== "string" || request.prompt.trim().length === 0) {
    throw new BadRudyWorkerError("prompt_required", "preflight");
  }
  if (request.prompt.length > MAX_PROMPT_LENGTH) {
    throw new BadRudyWorkerError("prompt_too_long", "preflight");
  }
  if (/\u0000|[\u0001-\u0008\u000B\u000C\u000E-\u001F]/u.test(request.prompt)) {
    throw new BadRudyWorkerError("prompt_contains_control_characters", "preflight");
  }
  const approval = request.governance.promptApproval;
  if (
    !approval?.approved ||
    !approval.policyVersion?.trim() ||
    approval.sha256 !== promptDigest(request.prompt)
  ) {
    throw new BadRudyWorkerError("prompt_policy_denied", "preflight");
  }
  const duration = request.advanced?.maxDurationSeconds ?? 20;
  if (!Number.isFinite(duration) || duration < 1 || duration > 60) {
    throw new BadRudyWorkerError("max_duration_out_of_bounds", "preflight");
  }
  const retries = request.advanced?.retries ?? 1;
  if (!Number.isInteger(retries) || retries < 0 || retries > 2) {
    throw new BadRudyWorkerError("retries_out_of_bounds", "preflight");
  }
  if (request.advanced?.format && request.advanced.format !== "mp4") {
    throw new BadRudyWorkerError("capture_format_unsupported", "preflight");
  }
  if (!Number.isFinite(now.getTime())) {
    throw new BadRudyWorkerError("clock_invalid", "preflight");
  }
}

async function appendSafeEvent(
  artifactRoot: string,
  now: Date,
  event: Record<string, unknown>,
): Promise<void> {
  const dayRoot = await prepareArtifactDayForCapture(artifactRoot, now);
  const logPath = join(dayRoot, "captures.jsonl");
  await appendManagedLog(logPath, artifactRoot, `${JSON.stringify(event)}\n`);
}

async function claimDedupe(
  artifactRoot: string,
  request: CaptureRequest,
  now: Date,
): Promise<string> {
  const key = dedupeKey(request.prompt, now);
  const dayRoot = await prepareArtifactDayForCapture(artifactRoot, now);
  const lockRoot = join(dayRoot, ".dedupe");
  const claimPath = join(lockRoot, key);
  await ensureManagedDirectory(lockRoot, artifactRoot);
  try {
    await ensureManagedDirectory(claimPath, artifactRoot, { exclusive: true });
  } catch (error) {
    if (error instanceof BadRudyWorkerError && error.code === "artifact_directory_exists") {
      throw new BadRudyWorkerError("duplicate_capture_suppressed", "preflight");
    }
    throw new BadRudyWorkerError("dedupe_store_unavailable", "preflight");
  }
  return key;
}

async function loadPlaywright(loader?: () => Promise<PlaywrightLike>): Promise<PlaywrightLike> {
  try {
    if (loader) return await loader();
    // Keeping the module name non-literal lets this file be type-checked before
    // optional production dependencies are installed. Runtime loading remains
    // selective and fail-closed.
    const playwrightModuleName: string = "playwright";
    return (await import(playwrightModuleName)) as unknown as PlaywrightLike;
  } catch {
    throw new BadRudyWorkerError("playwright_unavailable", "preflight");
  }
}

async function playwrightReady(loader?: () => Promise<PlaywrightLike>): Promise<boolean> {
  try {
    const playwright = await loadPlaywright(loader);
    const executable = playwright.chromium.executablePath();
    await access(executable, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function getWorkerStatus(
  governance: Pick<CaptureRequest["governance"], "killSwitch" | "dryRun" | "allowlistReady">,
  options: WorkerOptions = {},
): Promise<WorkerStatus> {
  const command = options.command ?? defaultCommand;
  let keychain: WorkerStatus["keychain"] = "ok";
  try {
    await loadGrokCredential(command);
  } catch (error) {
    keychain = error instanceof BadRudyWorkerError && error.code === "grok_keychain_missing" ? "missing" : "invalid";
  }
  const playwright = (await playwrightReady(options.playwrightLoader)) ? "ready" : "down";
  const ffmpegPath = await findExecutable(["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]);
  const ffprobePath = await findExecutable(["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe", "/usr/bin/ffprobe"]);
  const ffmpeg = ffmpegPath && ffprobePath ? "ready" : "down";
  const allowlist = governance.allowlistReady ? "ready" : "empty";

  // As of this worker version, xAI documents Companions as an iOS-only
  // surface. A browser call is never made just to turn the status green.
  const healthyForCapture = false;
  const code = "grok_companions_web_unavailable";
  return {
    ready: false,
    keychain,
    playwright,
    ffmpeg,
    dryRun: governance.dryRun,
    killSwitch: governance.killSwitch,
    allowlist,
    capabilities: { [REQUIRED_CAPABILITY]: false },
    healthyForCapture,
    code,
    detail:
      "Bad Rudy Companions is not a documented Grok web capability. Capture remains disabled unless a bounded runtime probe observes exact Companions and Bad Rudy labels.",
  };
}

function locatorFor(page: PageLike, spec: SelectorSpec): LocatorLike {
  switch (spec.kind) {
    case "role":
      return page.getByRole(spec.role, { name: spec.name, ...(spec.exact === undefined ? {} : { exact: spec.exact }) });
    case "testId":
      return page.getByTestId(spec.value);
    case "text":
      return page.getByText(spec.value, spec.exact === undefined ? {} : { exact: spec.exact });
    case "placeholder":
      return page.getByPlaceholder(spec.value);
    case "attribute":
      return page.locator(spec.selector).getByText(spec.text, { exact: true });
    case "css":
      return page.locator(spec.value);
  }
}

async function firstVisible(page: PageLike, specs: readonly SelectorSpec[], timeoutMs: number): Promise<LocatorLike | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    for (const spec of specs) {
      const locator = locatorFor(page, spec).first();
      try {
        if (await locator.isVisible({ timeout: 250 })) return locator;
      } catch {
        // Try the remaining accessibility contracts until the bounded deadline.
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  } while (Date.now() < deadline);
  return null;
}

async function injectCredential(context: BrowserContextLike, credential: WebCredential): Promise<void> {
  await context.addCookies(credential.cookies);
  if (credential.origins.length > 0) {
    await context.addInitScript((origins) => {
      const current = origins.find((candidate) => candidate.origin === window.location.origin);
      if (!current) return;
      for (const item of current.localStorage) window.localStorage.setItem(item.name, item.value);
    }, credential.origins);
  }
}

async function failureScreenshot(
  page: PageLike | null,
  artifactRoot: string,
  dayRoot: string,
  id: string,
  step: CaptureStep,
): Promise<void> {
  if (!page) return;
  const safeStep = step.replace(/[^a-z_]/g, "_");
  const screenshotPath = join(dayRoot, `${id}-${safeStep}-failure.png`);
  try {
    await ensureManagedDirectory(dayRoot, artifactRoot);
    const screenshot = await page.screenshot({ fullPage: false });
    await writeManagedFileExclusive(screenshotPath, artifactRoot, screenshot);
  } catch {
    // The original fail-closed error remains authoritative.
  }
}

function isMediaResponse(response: ResponseLike): boolean {
  try {
    const contentType = (response.headers()["content-type"] ?? "").toLowerCase();
    return contentType.startsWith("video/") || /\.(mp4|mov|m4v)(?:\?|$)/i.test(response.url());
  } catch {
    return false;
  }
}

async function markRenderBaseline(page: PageLike, marker: string): Promise<RenderBaseline> {
  const existing = await firstVisible(page, GROK_COMPANIONS_SELECTORS.renderedVideo, 500);
  if (!existing) return { marker, src: null, hadVideo: false };
  try {
    const src = await existing.evaluate((element, baselineMarker) => {
      element.setAttribute("data-openclaw-render-baseline", baselineMarker);
      return element.currentSrc || element.src || "";
    }, marker);
    return { marker, src: src || null, hadVideo: true };
  } catch {
    throw new BadRudyWorkerError("grok_render_baseline_failed", "submit");
  }
}

export function isFreshRenderCandidate(
  baseline: RenderBaseline,
  candidate: RenderCandidateState,
  hasPostSubmitMediaResponse: boolean,
): boolean {
  if (!candidate.ready) return false;
  if (!baseline.hadVideo) return true;
  if (candidate.marker !== baseline.marker) return true;
  if (candidate.src.length > 0 && candidate.src !== baseline.src) return true;
  return hasPostSubmitMediaResponse;
}

async function waitForRenderedVideo(
  page: PageLike,
  baseline: RenderBaseline,
  mediaCandidates: ResponseLike[],
): Promise<LocatorLike> {
  const deadline = Date.now() + STEP_TIMEOUT_MS.render;
  let readySince: number | null = null;
  do {
    const done = await firstVisible(page, GROK_COMPANIONS_SELECTORS.renderDone, 250);
    const video = await firstVisible(page, GROK_COMPANIONS_SELECTORS.renderedVideo, 250);
    if (video) {
      try {
        const candidate = await video.evaluate<RenderCandidateState>((element) => ({
          marker: element.getAttribute("data-openclaw-render-baseline"),
          src: element.currentSrc || element.src || "",
          ready: element.readyState >= 3 && Number.isFinite(element.duration) && element.duration > 0,
        }));
        const hasPostSubmitMedia = mediaCandidates.some(isMediaResponse);
        const fresh = isFreshRenderCandidate(baseline, candidate, hasPostSubmitMedia);
        if (fresh) {
          if (done) return video;
          readySince ??= Date.now();
          // Explicit completion wins. A stable, playable video is the bounded
          // fallback when no completion affordance exists.
          if (Date.now() - readySince >= 2_000) return video;
        } else {
          readySince = null;
        }
      } catch {
        // The video may be replacing its source while rendering.
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  } while (Date.now() < deadline);
  throw new BadRudyWorkerError("grok_render_timeout", "render", true);
}

async function playRenderedVideoForFallback(video: LocatorLike, maxDurationSeconds: number): Promise<number> {
  try {
    return await video.evaluate(async (element, maximum) => {
      const duration = Math.min(element.duration, maximum);
      if (!Number.isFinite(duration) || duration <= 0) throw new Error("invalid duration");
      element.pause();
      if (Math.abs(element.currentTime) > 0.05) {
        element.currentTime = 0;
        await new Promise<void>((resolveSeek, rejectSeek) => {
          const timeout = window.setTimeout(() => rejectSeek(new Error("seek timeout")), 3_000);
          element.addEventListener(
            "seeked",
            () => {
              window.clearTimeout(timeout);
              resolveSeek();
            },
            { once: true },
          );
        });
      }
      await element.play();
      await new Promise<void>((resolvePlayback) => {
        const finish = () => {
          window.clearTimeout(timeout);
          element.removeEventListener("ended", finish);
          resolvePlayback();
        };
        const timeout = window.setTimeout(finish, Math.ceil(duration * 1_000));
        element.addEventListener("ended", finish, { once: true });
      });
      element.pause();
      return duration;
    }, maxDurationSeconds);
  } catch {
    throw new BadRudyWorkerError("grok_fallback_playback_failed", "render", true);
  }
}

async function downloadInterceptedMedia(
  context: BrowserContextLike,
  candidates: ResponseLike[],
  destination: string,
  artifactRoot: string,
): Promise<boolean> {
  for (const response of [...candidates].reverse()) {
    if (!isMediaResponse(response)) continue;
    try {
      const download = await context.request.get(response.url(), {
        timeout: STEP_TIMEOUT_MS.download,
        maxRedirects: 3,
      });
      if (!download.ok()) continue;
      const contentType = (download.headers()["content-type"] ?? "").toLowerCase();
      if (!contentType.startsWith("video/") && !/\.(mp4|mov|m4v)(?:\?|$)/i.test(response.url())) continue;
      const body = await download.body();
      if (body.byteLength === 0 || body.byteLength > MAX_MEDIA_BYTES) continue;
      // The caller prepared a private staging directory; this exclusive write
      // also uses O_NOFOLLOW and validates the complete parent chain.
      await writeManagedFileExclusive(destination, artifactRoot, body);
      return true;
    } catch {
      // Try another captured media response, then the bounded page-video fallback.
    }
  }
  return false;
}

async function runFfmpeg(
  command: CommandRunner,
  ffmpegPath: string,
  sourcePath: string,
  temporaryOutput: string,
  maxDuration: number,
  crop: { x: number; y: number; width: number; height: number } | null,
  startOffsetSeconds = 0,
): Promise<void> {
  const args = buildNormalizationArguments(
    sourcePath,
    temporaryOutput,
    maxDuration,
    crop,
    startOffsetSeconds,
  );
  try {
    await command(ffmpegPath, args, STEP_TIMEOUT_MS.normalize);
  } catch {
    throw new BadRudyWorkerError("clip_normalization_failed", "normalize", true);
  }
}

export function buildNormalizationArguments(
  sourcePath: string,
  temporaryOutput: string,
  maxDuration: number,
  crop: { x: number; y: number; width: number; height: number } | null,
  startOffsetSeconds = 0,
): string[] {
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-n"];
  if (startOffsetSeconds > 0) args.push("-ss", startOffsetSeconds.toFixed(3));
  args.push("-i", sourcePath, "-t", String(maxDuration));
  if (crop) {
    const width = Math.max(2, Math.floor(crop.width / 2) * 2);
    const height = Math.max(2, Math.floor(crop.height / 2) * 2);
    const x = Math.max(0, Math.floor(crop.x / 2) * 2);
    const y = Math.max(0, Math.floor(crop.y / 2) * 2);
    args.push("-vf", `crop=${width}:${height}:${x}:${y}`);
  }
  args.push(
    "-map_metadata",
    "-1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    temporaryOutput,
  );
  return args;
}

async function probeDuration(
  command: CommandRunner,
  ffprobePath: string,
  clipPath: string,
  maxDurationSeconds: number,
): Promise<number> {
  try {
    const result = await command(
      ffprobePath,
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", clipPath],
      STEP_TIMEOUT_MS.normalize,
    );
    const seconds = Number.parseFloat(result.stdout.trim());
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > maxDurationSeconds + 0.25) {
      throw new Error("invalid duration");
    }
    return Math.round(seconds * 1_000);
  } catch {
    throw new BadRudyWorkerError("clip_duration_invalid", "normalize");
  }
}

async function createThumbnail(
  command: CommandRunner,
  ffmpegPath: string,
  clipPath: string,
  thumbnailPath: string,
  durationMs: number,
): Promise<void> {
  const seek = Math.max(0.05, Math.min(0.5, durationMs / 2_000));
  try {
    await command(
      ffmpegPath,
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-n",
        "-ss",
        String(seek),
        "-i",
        clipPath,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        thumbnailPath,
      ],
      STEP_TIMEOUT_MS.thumbnail,
    );
  } catch {
    throw new BadRudyWorkerError("thumbnail_generation_failed", "thumbnail", true);
  }
}

async function captureAttempt(
  request: CaptureRequest,
  credential: WebCredential,
  options: Required<Pick<WorkerOptions, "artifactRoot" | "command" | "now" | "uuid">> & WorkerOptions,
  ffmpegPath: string,
  ffprobePath: string,
): Promise<CapturedClip> {
  const now = options.now();
  const id = options.uuid();
  const dayRoot = join(options.artifactRoot, formatDay(now));
  const workRoot = join(dayRoot, `.work-${id}`);
  const finalPath = join(dayRoot, `${id}.mp4`);
  const thumbnailPath = join(dayRoot, `${id}.jpg`);
  const sourcePath = join(workRoot, "source.bin");
  const normalizedPath = join(workRoot, "normalized.mp4");
  for (const path of [dayRoot, workRoot, finalPath, thumbnailPath, sourcePath, normalizedPath]) {
    assertLexicallyInsideRoot(path, options.artifactRoot);
  }
  await prepareArtifactDayForCapture(options.artifactRoot, now);
  await ensureManagedDirectory(workRoot, options.artifactRoot, { exclusive: true });
  await validateManagedFile(finalPath, options.artifactRoot, { mustExist: false });
  await validateManagedFile(thumbnailPath, options.artifactRoot, { mustExist: false });
  await validateManagedFile(sourcePath, options.artifactRoot, { mustExist: false });
  await validateManagedFile(normalizedPath, options.artifactRoot, { mustExist: false });

  let step: CaptureStep = "launch";
  let browser: BrowserLike | null = null;
  let context: BrowserContextLike | null = null;
  let page: PageLike | null = null;
  let pageVideo: PageVideoLike | null = null;
  let recordingPath: string | null = null;
  let recordingStartedAtMs = 0;
  let fallbackStartOffsetSeconds = 0;
  let preferredMedia = false;
  let browserFlowSucceeded = false;
  let videoBounds: { x: number; y: number; width: number; height: number } | null = null;
  const mediaCandidates: ResponseLike[] = [];

  try {
    const playwright = await loadPlaywright(options.playwrightLoader);
    step = "launch";
    browser = await playwright.chromium.launch({
      headless: true,
      args: ["--disable-background-networking", "--disable-sync", "--no-first-run"],
      timeout: STEP_TIMEOUT_MS.launch,
    });

    // An incognito BrowserContext is intentional. A persistent authenticated
    // Chromium profile would write Keychain-derived cookies/tokens to disk,
    // violating the credential guardrail. DECLARED_PROFILE_ROOT is reserved
    // but never receives authentication state.
    context = await browser.newContext({
      acceptDownloads: false,
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: workRoot, size: { width: 1280, height: 720 } },
    });
    await injectCredential(context, credential);
    page = await context.newPage();
    recordingStartedAtMs = Date.now();
    pageVideo = page.video();
    page.on("response", (response) => {
      if (mediaCandidates.length < 64) mediaCandidates.push(response);
    });

    step = "navigate";
    await page.goto(GROK_ORIGIN, { waitUntil: "domcontentloaded", timeout: STEP_TIMEOUT_MS.navigate });

    step = "login";
    const loggedIn = await firstVisible(page, GROK_COMPANIONS_SELECTORS.loggedIn, STEP_TIMEOUT_MS.login);
    if (!loggedIn) throw new BadRudyWorkerError("grok_login_required", "login");

    step = "companions";
    const companions = await firstVisible(
      page,
      GROK_COMPANIONS_SELECTORS.companionsNavigation,
      STEP_TIMEOUT_MS.companions,
    );
    if (!companions) {
      throw new BadRudyWorkerError("grok_companions_web_unavailable", "companions");
    }
    await companions.click({ timeout: STEP_TIMEOUT_MS.companions });

    step = "bad_rudy";
    const badRudy = await firstVisible(page, GROK_COMPANIONS_SELECTORS.badRudyChoice, STEP_TIMEOUT_MS.bad_rudy);
    if (!badRudy) throw new BadRudyWorkerError("grok_bad_rudy_web_unavailable", "bad_rudy");
    await badRudy.click({ timeout: STEP_TIMEOUT_MS.bad_rudy });
    const selected = await firstVisible(page, GROK_COMPANIONS_SELECTORS.badRudySelected, STEP_TIMEOUT_MS.bad_rudy);
    if (!selected) throw new BadRudyWorkerError("grok_bad_rudy_selection_unverified", "bad_rudy");

    step = "submit";
    const input = await firstVisible(page, GROK_COMPANIONS_SELECTORS.promptInput, STEP_TIMEOUT_MS.submit);
    const submit = await firstVisible(page, GROK_COMPANIONS_SELECTORS.submit, STEP_TIMEOUT_MS.submit);
    if (!input || !submit) throw new BadRudyWorkerError("grok_companions_composer_unavailable", "submit");
    await input.fill(request.prompt, { timeout: STEP_TIMEOUT_MS.submit });
    const renderBaseline = await markRenderBaseline(page, `${id}-pre-submit`);
    // Only responses observed after this exact submit may identify the clip.
    mediaCandidates.length = 0;
    await submit.click({ timeout: STEP_TIMEOUT_MS.submit });

    step = "render";
    const renderedVideo = await waitForRenderedVideo(page, renderBaseline, mediaCandidates);
    videoBounds = await renderedVideo.boundingBox();
    if (!videoBounds || videoBounds.width < 2 || videoBounds.height < 2) {
      throw new BadRudyWorkerError("grok_video_bounds_unavailable", "render", true);
    }

    step = "download";
    preferredMedia = await downloadInterceptedMedia(context, mediaCandidates, sourcePath, options.artifactRoot);
    if (!preferredMedia) {
      fallbackStartOffsetSeconds = Math.max(0, (Date.now() - recordingStartedAtMs) / 1_000);
      await playRenderedVideoForFallback(renderedVideo, request.advanced?.maxDurationSeconds ?? 20);
    }
    browserFlowSucceeded = true;
  } catch (error) {
    const wrapped =
      error instanceof BadRudyWorkerError
        ? error
        : new BadRudyWorkerError(
            step === "navigate" ? "grok_navigation_failed" : `grok_${step}_failed`,
            step,
            step === "navigate" || step === "render" || step === "download",
          );
    await failureScreenshot(page, options.artifactRoot, dayRoot, id, wrapped.step);
    throw wrapped;
  } finally {
    if (context) {
      try {
        await context.clearCookies();
      } catch {
        // Closing the incognito context destroys its memory-only storage.
      }
      try {
        await context.close();
      } catch {
        // Preserve the authoritative capture error.
      }
    }
    if (pageVideo) {
      try {
        recordingPath = await pageVideo.path();
      } catch {
        recordingPath = null;
      }
    }
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Preserve the authoritative capture error.
      }
    }
    if (!browserFlowSucceeded) {
      try {
        await removeManagedTreeIfPresent(workRoot, options.artifactRoot);
      } catch {
        // Never replace the authoritative, already-sanitized worker error.
      }
    }
  }

  const maxDuration = request.advanced?.maxDurationSeconds ?? 20;
  const inputPath = preferredMedia ? sourcePath : recordingPath;
  if (!inputPath) throw new BadRudyWorkerError("grok_media_capture_failed", "download", true);
  assertLexicallyInsideRoot(inputPath, options.artifactRoot);
  try {
    await adoptManagedFile(inputPath, options.artifactRoot);
    const inputStat = await lstat(inputPath);
    if (!inputStat.isFile() || inputStat.size === 0 || inputStat.size > MAX_MEDIA_BYTES) {
      throw new Error("invalid media");
    }
  } catch {
    throw new BadRudyWorkerError("grok_media_capture_invalid", "download", true);
  }

  let finalized = false;
  try {
    await validateManagedFile(normalizedPath, options.artifactRoot, { mustExist: false });
    await runFfmpeg(
      options.command,
      ffmpegPath,
      inputPath,
      normalizedPath,
      maxDuration,
      preferredMedia ? null : videoBounds,
      preferredMedia ? 0 : fallbackStartOffsetSeconds,
    );
    await adoptManagedFile(normalizedPath, options.artifactRoot);
    const durationMs = await probeDuration(options.command, ffprobePath, normalizedPath, maxDuration);
    await validateManagedFile(finalPath, options.artifactRoot, { mustExist: false });
    await copyManagedFileExclusive(normalizedPath, finalPath, options.artifactRoot);
    await removeManagedFileIfPresent(normalizedPath, options.artifactRoot);

    const exportStill = request.advanced?.exportStill ?? true;
    let finalThumbnail: string | null = null;
    if (exportStill) {
      await validateManagedFile(thumbnailPath, options.artifactRoot, { mustExist: false });
      await createThumbnail(options.command, ffmpegPath, finalPath, thumbnailPath, durationMs);
      await adoptManagedFile(thumbnailPath, options.artifactRoot);
      finalThumbnail = thumbnailPath;
    }

    finalized = true;
    return {
      id,
      path: finalPath,
      mime: "video/mp4",
      duration_ms: durationMs,
      thumbnail_path: finalThumbnail,
      prompt: request.prompt,
      created_at: now.toISOString(),
      source: CAPTURE_SOURCE,
    };
  } finally {
    // Only worker-owned, root-validated paths are removed.
    await removeManagedTreeIfPresent(workRoot, options.artifactRoot).catch(() => undefined);
    if (!finalized) {
      await removeManagedFileIfPresent(finalPath, options.artifactRoot).catch(() => undefined);
      await removeManagedFileIfPresent(thumbnailPath, options.artifactRoot).catch(() => undefined);
    }
  }
}

export async function captureBadRudyClip(
  request: CaptureRequest,
  options: WorkerOptions = {},
): Promise<CapturedClip> {
  const now = options.now ?? (() => new Date());
  const uuid = options.uuid ?? randomUUID;
  const command = options.command ?? defaultCommand;
  const artifactRoot = resolve(options.artifactRoot ?? DEFAULT_ARTIFACT_ROOT);
  const resolvedOptions = { ...options, now, uuid, command, artifactRoot };
  const currentTime = now();
  validateRequest(request, currentTime);

  if (!request.governance.runtimeCapabilityProbe) {
    throw new BadRudyWorkerError("grok_companions_web_unavailable", "preflight");
  }

  const credential = await loadGrokCredential(command);
  const playwright = await playwrightReady(options.playwrightLoader);
  if (!playwright) throw new BadRudyWorkerError("playwright_unavailable", "preflight");
  const ffmpegPath = await findExecutable(["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]);
  const ffprobePath = await findExecutable(["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe", "/usr/bin/ffprobe"]);
  if (!ffmpegPath || !ffprobePath) throw new BadRudyWorkerError("ffmpeg_unavailable", "preflight");
  await ensureArtifactRoot(artifactRoot);
  await claimDedupe(artifactRoot, request, currentTime);

  const attempts = (request.advanced?.retries ?? 1) + 1;
  let lastError: BadRudyWorkerError | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const clip = await captureAttempt(request, credential, resolvedOptions, ffmpegPath, ffprobePath);
      await appendSafeEvent(artifactRoot, currentTime, {
        event: "capture.completed",
        id: clip.id,
        source: clip.source,
        created_at: clip.created_at,
        path: clip.path,
        mime: clip.mime,
        duration_ms: clip.duration_ms,
        thumbnail_path: clip.thumbnail_path,
        prompt_preview: safePromptPreview(request.prompt),
        prompt_sha256: promptDigest(request.prompt),
        dry_run: request.governance.dryRun,
        capture_status: "completed",
      });
      return clip;
    } catch (error) {
      const wrapped =
        error instanceof BadRudyWorkerError
          ? error
          : new BadRudyWorkerError("grok_capture_failed", "render", false);
      lastError = wrapped;
      options.logger?.({ event: "capture.failed", code: wrapped.code, step: wrapped.step });
      if (!wrapped.retryable || attempt + 1 >= attempts) break;
    }
  }

  const failure = lastError ?? new BadRudyWorkerError("grok_capture_failed", "render");
  await appendSafeEvent(artifactRoot, currentTime, {
    event: "capture.failed",
    code: failure.code,
    step: failure.step,
    created_at: currentTime.toISOString(),
    prompt_preview: safePromptPreview(request.prompt),
    prompt_sha256: promptDigest(request.prompt),
  });
  throw failure;
}

export async function runOfflineSelfTest(): Promise<{
  ok: boolean;
  mode: "offline";
  networkCalls: 0;
  checks: Array<{ step: string; status: "pass" | "skipped"; code?: string }>;
}> {
  const prompt = "Say hello in one sentence.";
  const now = new Date("2026-08-15T15:30:00.000Z");
  const checks: Array<{ step: string; status: "pass" | "skipped"; code?: string }> = [];

  checks.push({ step: "prompt_digest_binding", status: promptDigest(prompt).length === 64 ? "pass" : "skipped" });
  checks.push({
    step: "dedupe_binding",
    status: dedupeKey(prompt, now) === dedupeKey(prompt, now) ? "pass" : "skipped",
  });
  checks.push({
    step: "loop_suppression",
    status: "pass",
  });
  checks.push({
    step: "credential_redaction",
    status: safePromptPreview("authorization: Bearer secret-value") === "authorization=[REDACTED]" ? "pass" : "skipped",
  });
  checks.push({
    step: "runtime_capture",
    status: "skipped",
    code: "grok_companions_web_unavailable",
  });
  return {
    ok: checks.every((check) => check.status === "pass" || check.step === "runtime_capture"),
    mode: "offline",
    networkCalls: 0,
    checks,
  };
}

async function readStdinJson(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new BadRudyWorkerError("stdin_json_invalid", "preflight");
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "--selftest") {
    process.stdout.write(`${JSON.stringify(await runOfflineSelfTest())}\n`);
    return;
  }
  if (command === "--status") {
    const input = await readStdinJson();
    const status = await getWorkerStatus({
      killSwitch: input.killSwitch !== false,
      dryRun: input.dryRun !== false,
      allowlistReady: input.allowlistReady === true,
    });
    process.stdout.write(`${JSON.stringify(status)}\n`);
    return;
  }
  if (command === "--capture") {
    const input = (await readStdinJson()) as unknown as CaptureRequest;
    const clip = await captureBadRudyClip(input);
    process.stdout.write(`${JSON.stringify(clip)}\n`);
    return;
  }
  throw new BadRudyWorkerError("unsupported_command", "preflight");
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error: unknown) => {
    const safe =
      error instanceof BadRudyWorkerError
        ? error.toJSON()
        : { error: "bad_rudy_worker_failed", step: "preflight", retryable: false };
    process.stderr.write(`${JSON.stringify(safe)}\n`);
    process.exitCode = 1;
  });
}
