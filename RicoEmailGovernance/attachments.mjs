import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RicoEmailPolicyError, validateAttachmentDescriptor } from "./policy.mjs";

export function validateAllowedAttachmentRoots(input) {
  if (!Array.isArray(input) || input.length > 20) throw coded("attachment_roots_invalid");
  const roots = [];
  for (const item of input) {
    const raw = String(item ?? "").trim();
    if (!raw || !path.isAbsolute(raw)) throw coded("attachment_root_not_absolute");
    const resolved = path.resolve(raw);
    if (!path.isAbsolute(resolved)) throw coded("attachment_root_not_absolute");
    const stat = fs.lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw coded("attachment_root_invalid");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw coded("attachment_root_owner_mismatch");
    const real = fs.realpathSync(resolved);
    if (!roots.includes(real)) roots.push(real);
  }
  return Object.freeze(roots);
}

export function verifyLocalAttachments(descriptors, allowedRoots) {
  const roots = validateAllowedAttachmentRoots(allowedRoots);
  return Object.freeze(descriptors.map((item) => verifyOne(validateAttachmentDescriptor(item), roots)));
}

function verifyOne(descriptor, roots) {
  if (roots.length === 0) throw coded("attachment_roots_empty");
  const candidate = path.resolve(descriptor.path);
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw coded("attachment_file_invalid");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw coded("attachment_file_owner_mismatch");
  const real = fs.realpathSync(candidate);
  if (!roots.some((root) => isWithin(root, real))) throw coded("attachment_outside_allowed_roots");
  if (stat.size !== descriptor.byteSize) throw coded("attachment_size_mismatch");
  const digest = createHash("sha256").update(fs.readFileSync(real)).digest("hex");
  if (digest !== descriptor.sha256) throw coded("attachment_digest_mismatch");
  return Object.freeze({
    path: real,
    filename: path.basename(real),
    mime: descriptor.mime,
    byteSize: descriptor.byteSize,
    sha256: descriptor.sha256,
  });
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function coded(code) {
  return new RicoEmailPolicyError(code);
}
