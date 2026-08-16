import fs from "node:fs";
import path from "node:path";

export const DEFAULT_IMSG_LINK = "/opt/homebrew/bin/imsg";
export const DEFAULT_IMSG_CELLAR = "/opt/homebrew/Cellar/imsg";

export function resolveIMsgExecutable(value = undefined) {
  if (value !== undefined && value !== null) return secureExecutable(value, "imsg_unavailable");
  return resolveManagedIMsgExecutable();
}

export function resolveManagedIMsgExecutable({
  linkPath = DEFAULT_IMSG_LINK,
  cellarRoot = DEFAULT_IMSG_CELLAR,
} = {}) {
  const link = exactAbsolute(linkPath, "imsg_unavailable");
  const cellar = exactAbsolute(cellarRoot, "imsg_unavailable");
  const prefix = path.dirname(path.dirname(link));
  if (path.basename(link) !== "imsg" || path.basename(path.dirname(link)) !== "bin"
    || cellar !== path.join(prefix, "Cellar", "imsg")) throw coded("imsg_unavailable");

  let linkStat;
  try { linkStat = fs.lstatSync(link); } catch { throw coded("imsg_unavailable"); }
  if (linkStat.isFile() && !linkStat.isSymbolicLink()) return secureExecutable(link, "imsg_unavailable");
  if (!linkStat.isSymbolicLink()) throw coded("imsg_unavailable");

  let target;
  try {
    if (fs.realpathSync(cellar) !== cellar) throw coded("imsg_unavailable");
    target = fs.realpathSync(link);
  } catch {
    throw coded("imsg_unavailable");
  }
  const relative = path.relative(cellar, target).split(path.sep);
  if (relative.length !== 3 || relative[0] === "" || relative[0] === ".."
    || !/^[A-Za-z0-9._+-]{1,80}$/u.test(relative[0])
    || relative[1] !== "bin" || relative[2] !== "imsg") throw coded("imsg_unavailable");
  return secureExecutable(target, "imsg_unavailable");
}

function secureExecutable(value, code) {
  const resolved = exactAbsolute(value, code);
  let stat;
  try { stat = fs.lstatSync(resolved); } catch { throw coded(code); }
  const ownerAllowed = typeof process.getuid !== "function" || stat.uid === process.getuid() || stat.uid === 0;
  if (!stat.isFile() || stat.isSymbolicLink() || !ownerAllowed
    || (stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0) throw coded(code);
  return resolved;
}

function exactAbsolute(value, code) {
  const text = String(value ?? "");
  if (!path.isAbsolute(text) || path.resolve(text) !== text) throw coded(code);
  return text;
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
