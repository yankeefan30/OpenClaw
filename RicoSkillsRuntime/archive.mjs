import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { IMPORT_LIMITS } from "./constants.mjs";
import { RicoSkillError, invariant } from "./errors.mjs";
import { validateRelativePath, validateTextFile } from "./policy.mjs";

const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END_HEADER = 0x06054b50;
const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP64_END_MARKER = 0xffff;

export async function collectSourceFiles(sourcePath, workspaceRoot) {
  const source = path.resolve(sourcePath);
  const root = path.resolve(workspaceRoot);
  await ensurePrivateDirectory(root);
  const stat = await fsp.lstat(source);
  invariant(!stat.isSymbolicLink(), "symlink", "Symbolic links cannot be imported.");

  if (stat.isFile() && path.extname(source).toLowerCase() === ".zip") {
    return collectZip(source, root);
  }
  if (stat.isFile()) return collectRegularFile(source, path.basename(source));
  invariant(stat.isDirectory(), "unknown_content", "Choose a text file, folder, or ZIP archive.");
  return collectDirectory(source);
}

async function collectRegularFile(source, relativePath) {
  const stat = await fsp.lstat(source);
  invariant(stat.isFile() && !stat.isSymbolicLink(), "unknown_content", "The selected source is not a regular file.");
  invariant(stat.nlink === 1, "hardlink", "Hard-linked files cannot be imported.");
  const data = await fsp.readFile(source);
  return [validateTextFile({ relativePath, data, mode: stat.mode })];
}

async function collectDirectory(source) {
  const collected = [];
  const seen = new Set();
  let totalBytes = 0;

  async function visit(directory, relativeDirectory = "") {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (isMetadataEntry(entry.name, relativeDirectory)) continue;
      const relativePath = validateRelativePath(path.posix.join(relativeDirectory, entry.name));
      const normalizedKey = relativePath.normalize("NFC").toLocaleLowerCase("en-US");
      invariant(!seen.has(normalizedKey), "duplicate_path", `The import contains duplicate or case-conflicting paths: ${relativePath}`);
      seen.add(normalizedKey);
      const absolute = path.join(directory, entry.name);
      const stat = await fsp.lstat(absolute);
      invariant(!stat.isSymbolicLink(), "symlink", `Symbolic links cannot be imported: ${relativePath}`);
      if (stat.isDirectory()) {
        await visit(absolute, relativePath);
        continue;
      }
      invariant(stat.isFile(), "unknown_content", `Special filesystem entries cannot be imported: ${relativePath}`);
      invariant(stat.nlink === 1, "hardlink", `Hard-linked files cannot be imported: ${relativePath}`);
      invariant(collected.length < IMPORT_LIMITS.fileCount, "too_many_files", `Imports may contain at most ${IMPORT_LIMITS.fileCount} files.`);
      const data = await fsp.readFile(absolute);
      totalBytes += data.length;
      invariant(totalBytes <= IMPORT_LIMITS.totalBytes, "import_too_large", `Import text exceeds ${IMPORT_LIMITS.totalBytes} bytes.`);
      collected.push(validateTextFile({ relativePath, data, mode: stat.mode }));
    }
  }

  await visit(source);
  invariant(collected.length > 0, "empty_import", "No importable text files were found.");
  return collected.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function collectZip(source, workspaceRoot) {
  const archiveStat = await fsp.lstat(source);
  invariant(archiveStat.nlink === 1, "hardlink", "Hard-linked archives cannot be imported.");
  invariant(archiveStat.size <= IMPORT_LIMITS.archiveBytes, "archive_too_large", `ZIP archive exceeds ${IMPORT_LIMITS.archiveBytes} bytes.`);

  // Copy the exact bytes that were inspected into a private directory before
  // extraction. This closes the archive-replacement race between validation
  // and /usr/bin/unzip.
  const archiveBytes = await fsp.readFile(source);
  const entries = inspectZip(archiveBytes);
  const extractionRoot = await fsp.mkdtemp(path.join(workspaceRoot, ".extract-"));
  await fsp.chmod(extractionRoot, 0o700);
  const privateArchive = path.join(extractionRoot, "source.zip");
  await fsp.writeFile(privateArchive, archiveBytes, { mode: 0o600, flag: "wx" });
  const expanded = path.join(extractionRoot, "expanded");
  await fsp.mkdir(expanded, { mode: 0o700 });

  try {
    const executable = fs.existsSync("/usr/bin/unzip") ? "/usr/bin/unzip" : "unzip";
    const result = spawnSync(executable, ["-qq", "--", privateArchive, "-d", expanded], {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 256 * 1024,
    });
    invariant(result.status === 0, "archive_extract_failed", "The ZIP archive could not be extracted safely.");
    const extracted = await collectDirectory(expanded);
    const expected = new Set(entries.filter((entry) => !entry.directory && !isMetadataPath(entry.name)).map((entry) => entry.name));
    const actual = new Set(extracted.map((entry) => entry.relativePath));
    invariant(expected.size === actual.size && [...expected].every((value) => actual.has(value)), "archive_mismatch", "The extracted ZIP did not match its reviewed directory.");
    return extracted;
  } finally {
    await removePrivateTemporaryDirectory(extractionRoot, workspaceRoot);
  }
}

export function inspectZip(data) {
  invariant(Buffer.isBuffer(data), "invalid_archive", "ZIP input is invalid.");
  const minimum = Math.max(0, data.length - 65_557);
  let endOffset = -1;
  for (let offset = data.length - 22; offset >= minimum; offset -= 1) {
    if (data.readUInt32LE(offset) === ZIP_END_HEADER) { endOffset = offset; break; }
  }
  invariant(endOffset >= 0, "invalid_archive", "The selected ZIP has no valid central directory.");
  const entryCount = data.readUInt16LE(endOffset + 10);
  const centralSize = data.readUInt32LE(endOffset + 12);
  const centralOffset = data.readUInt32LE(endOffset + 16);
  invariant(entryCount !== ZIP64_END_MARKER && centralSize !== 0xffffffff && centralOffset !== 0xffffffff, "zip64_unsupported", "ZIP64 imports are not supported.");
  invariant(entryCount <= IMPORT_LIMITS.fileCount + 50, "too_many_files", `ZIP imports may contain at most ${IMPORT_LIMITS.fileCount} content files.`);
  invariant(centralOffset + centralSize <= endOffset, "invalid_archive", "The ZIP central directory is outside the archive.");

  const entries = [];
  const names = new Set();
  let totalBytes = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    invariant(cursor + 46 <= data.length && data.readUInt32LE(cursor) === ZIP_CENTRAL_HEADER, "invalid_archive", "The ZIP central directory is malformed.");
    const flags = data.readUInt16LE(cursor + 8);
    const method = data.readUInt16LE(cursor + 10);
    const uncompressedSize = data.readUInt32LE(cursor + 24);
    const nameLength = data.readUInt16LE(cursor + 28);
    const extraLength = data.readUInt16LE(cursor + 30);
    const commentLength = data.readUInt16LE(cursor + 32);
    const externalAttributes = data.readUInt32LE(cursor + 38);
    const localOffset = data.readUInt32LE(cursor + 42);
    invariant((flags & 0x1) === 0, "encrypted_archive", "Encrypted ZIP imports are not supported.");
    invariant(method === 0 || method === 8, "archive_compression", "The ZIP uses an unsupported compression method.");
    const rawName = data.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = decodeZipName(rawName, flags);
    const directory = name.endsWith("/");
    const cleanName = validateRelativePath(directory ? name.slice(0, -1) : name);
    const canonicalName = cleanName.toLocaleLowerCase("en-US");
    invariant(!names.has(canonicalName), "duplicate_path", `The ZIP contains duplicate or case-conflicting paths: ${cleanName}`);
    names.add(canonicalName);
    const unixMode = externalAttributes >>> 16;
    const type = unixMode & 0o170000;
    invariant(type !== 0o120000, "symlink", `ZIP symbolic links cannot be imported: ${cleanName}`);
    invariant(type === 0 || type === 0o100000 || type === 0o040000, "unknown_content", `ZIP special entries cannot be imported: ${cleanName}`);
    invariant((unixMode & 0o111) === 0, "executable_content", `ZIP executable permissions are not allowed: ${cleanName}`);
    if (!directory && !isMetadataPath(cleanName)) {
      invariant(uncompressedSize <= IMPORT_LIMITS.fileBytes, "file_too_large", `ZIP entry is too large: ${cleanName}`);
      totalBytes += uncompressedSize;
      invariant(totalBytes <= IMPORT_LIMITS.totalBytes, "import_too_large", `ZIP text exceeds ${IMPORT_LIMITS.totalBytes} bytes.`);
    }
    validateLocalHeader(data, localOffset, rawName);
    entries.push({ name: cleanName, directory, uncompressedSize, unixMode });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  invariant(cursor === centralOffset + centralSize, "invalid_archive", "The ZIP central directory length is inconsistent.");
  return entries;
}

function validateLocalHeader(data, offset, centralName) {
  invariant(offset + 30 <= data.length && data.readUInt32LE(offset) === ZIP_LOCAL_HEADER, "invalid_archive", "A ZIP local header is malformed.");
  const localNameLength = data.readUInt16LE(offset + 26);
  const localName = data.subarray(offset + 30, offset + 30 + localNameLength);
  invariant(localName.equals(centralName), "archive_mismatch", "A ZIP entry name differs between local and central headers.");
}

function decodeZipName(bytes, flags) {
  invariant((flags & 0x800) !== 0 || bytes.every((byte) => byte < 0x80), "archive_filename_encoding", "ZIP filenames must be UTF-8 or ASCII.");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new RicoSkillError("archive_filename_encoding", "A ZIP filename is not valid UTF-8."); }
}

function isMetadataEntry(name, relativeDirectory) {
  return name === ".DS_Store" || name === "Thumbs.db" || (relativeDirectory === "" && name === "__MACOSX");
}

function isMetadataPath(value) {
  return value === ".DS_Store" || value.endsWith("/.DS_Store") || value === "Thumbs.db" || value.endsWith("/Thumbs.db") || value === "__MACOSX" || value.startsWith("__MACOSX/");
}

export async function ensurePrivateDirectory(directory) {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fsp.lstat(directory);
  invariant(stat.isDirectory() && !stat.isSymbolicLink(), "unsafe_store", "The Rico skills workspace must be a real directory.");
  invariant(stat.uid === process.getuid(), "unsafe_store", "The Rico skills workspace must be owned by the current user.");
  await fsp.chmod(directory, 0o700);
}

async function removePrivateTemporaryDirectory(target, parent) {
  const resolvedTarget = path.resolve(target);
  const resolvedParent = `${path.resolve(parent)}${path.sep}`;
  invariant(resolvedTarget.startsWith(resolvedParent) && path.basename(resolvedTarget).startsWith(".extract-"), "unsafe_cleanup", "Refusing to clean an unexpected path.");
  await fsp.rm(resolvedTarget, { recursive: true, force: false });
}
