import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { codedError } from "./errors.mjs";
import { assertPrivateRegularFileInside, assertPathInside } from "./security.mjs";

export const CAPTURED_CLIP_SOURCE = "grok:bad-rudy";
export const CAPTURED_CLIP_SCHEMA = "openclaw.captured-clip/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function validateCapturedClip(input, { artifactRoot, expectedPrompt, maxDurationSeconds = 20, requireThumbnail = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw codedError("capture_contract_invalid", "The Playwright worker returned an invalid capture.");
  const id = String(input.id ?? "").trim().toLowerCase();
  if (!UUID.test(id)) throw codedError("capture_contract_invalid", "The capture ID is invalid.");
  const prompt = String(input.prompt ?? "");
  if (prompt !== expectedPrompt) throw codedError("capture_prompt_mismatch", "The captured clip does not match the reviewed prompt.");
  if (input.source !== CAPTURED_CLIP_SOURCE) throw codedError("capture_source_invalid", "The worker did not identify the Bad Rudy source exactly.");
  const createdAt = normalizeTimestamp(input.created_at);
  const mime = String(input.mime ?? "").toLowerCase();
  if (mime !== "video/mp4") throw codedError("capture_format_invalid", "Bad Rudy currently accepts local MP4 captures only.");
  const durationMs = Number(input.duration_ms);
  if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > maxDurationSeconds * 1_000) throw codedError("capture_duration_invalid", "The captured clip exceeds the reviewed duration cap.");

  const clipPath = assertCaptureFile(artifactRoot, input.path, ".mp4");
  const clipStat = fs.lstatSync(clipPath);
  if (clipStat.size < 1 || clipStat.size > 250 * 1024 * 1024) throw codedError("capture_size_invalid", "The captured clip has an invalid byte size.");
  const thumbnailPath = input.thumbnail_path == null ? null : assertCaptureFile(artifactRoot, input.thumbnail_path, ".jpg");
  if (requireThumbnail && !thumbnailPath) {
    throw codedError("capture_thumbnail_required", "A reviewed outbound clip requires a local still thumbnail.");
  }
  const sha256 = await hashFile(clipPath);
  const thumbnailSHA256 = thumbnailPath ? await hashFile(thumbnailPath) : null;
  return Object.freeze({
    schema: CAPTURED_CLIP_SCHEMA,
    schema_version: 1,
    id,
    path: clipPath,
    mime,
    duration_ms: durationMs,
    thumbnail_path: thumbnailPath,
    prompt,
    created_at: createdAt,
    source: CAPTURED_CLIP_SOURCE,
    byte_size: clipStat.size,
    sha256,
    thumbnail_sha256: thumbnailSHA256,
  });
}

export function confirmationDisplay(clip, { recipient = null, channel = null, scheduledAt = null } = {}) {
  return Object.freeze({
    recipient,
    channel,
    filename: path.basename(clip.path),
    byteSize: clip.byte_size,
    durationMs: clip.duration_ms,
    thumbnailPath: clip.thumbnail_path,
    scheduledAt,
  });
}

export function assertClipUnchanged(clip, artifactRoot) {
  const clipPath = assertCaptureFile(artifactRoot, clip.path, ".mp4");
  const stat = fs.lstatSync(clipPath);
  if (stat.size !== clip.byte_size) throw codedError("capture_changed", "The captured clip changed after review.");
  if (clip.thumbnail_path) assertCaptureFile(artifactRoot, clip.thumbnail_path, ".jpg");
  return clipPath;
}

export async function assertClipFingerprint(clip, artifactRoot, { requireThumbnail = false } = {}) {
  assertClipUnchanged(clip, artifactRoot);
  if (requireThumbnail && !clip.thumbnail_path) {
    throw codedError("capture_thumbnail_required", "A reviewed outbound clip requires a local still thumbnail.");
  }
  if (await hashFile(clip.path) !== clip.sha256) throw codedError("capture_changed", "The captured clip changed after review.");
  if (clip.thumbnail_path && await hashFile(clip.thumbnail_path) !== clip.thumbnail_sha256) {
    throw codedError("capture_changed", "The capture thumbnail changed after review.");
  }
}

function assertCaptureFile(artifactRoot, candidate, extension) {
  const resolved = assertPathInside(artifactRoot, String(candidate ?? ""));
  const relative = path.relative(path.resolve(artifactRoot), resolved);
  const parts = relative.split(path.sep);
  if (parts.length !== 2 || !/^\d{4}-\d{2}-\d{2}$/u.test(parts[0]) || path.extname(resolved).toLowerCase() !== extension) {
    throw codedError("capture_path_invalid", "The Playwright worker wrote outside the required dated artifact folder.");
  }
  let stat;
  try {
    assertPrivateRegularFileInside(artifactRoot, resolved);
    stat = fs.lstatSync(resolved);
  } catch (error) {
    if (error?.code === "capture_file_unsafe" || error?.code === "unsafe_state_directory" || error?.code === "unsafe_state_permissions" || error?.code === "wrong_state_owner") throw error;
    throw codedError("capture_file_missing", "The captured clip is missing from local storage.", error);
  }
  void stat;
  return resolved;
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath, { flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

function normalizeTimestamp(input) {
  const value = String(input ?? "");
  const timestamp = Date.parse(value);
  if (!value || !Number.isFinite(timestamp)) throw codedError("capture_contract_invalid", "The capture timestamp is invalid.");
  return new Date(timestamp).toISOString();
}
