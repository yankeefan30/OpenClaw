import { execFile as execFileCallback } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { ALLOWED_HOSTNAMES, ALLOWED_LOCAL_HOST_NAMES } from "./constants.mjs";
import { fail } from "./errors.mjs";

const execFile = promisify(execFileCallback);

const WRONG_HOST_MESSAGE =
  "This Pressmaster MCP is hostname-gated to original Rico (hostname Rico.local / LocalHostName Rico). This host is not original Rico. Aborting. Do not install or run this on Rico 2.";

export function normalizeHostLabel(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\.$/u, "");
}

export function isOriginalRicoHost({ hostname, localHostName } = {}) {
  const host = normalizeHostLabel(hostname);
  const local = normalizeHostLabel(localHostName);
  if (ALLOWED_HOSTNAMES.includes(host)) return true;
  if (ALLOWED_LOCAL_HOST_NAMES.includes(local)) return true;
  return false;
}

export async function inspectHost({
  hostnameFn = os.hostname,
  execFileFn = execFile,
} = {}) {
  const hostname = String(hostnameFn() ?? "");
  let localHostName = "";
  try {
    const result = await execFileFn("/usr/sbin/scutil", ["--get", "LocalHostName"], {
      encoding: "utf8",
      timeout: 3_000,
      env: { PATH: "/usr/sbin:/usr/bin:/bin" },
    });
    localHostName = String(result.stdout ?? "").trim();
  } catch {
    localHostName = "";
  }
  return { hostname, localHostName };
}

export async function assertOriginalRicoHost(inspect = inspectHost) {
  const identity = typeof inspect === "function" ? await inspect() : inspect;
  if (!isOriginalRicoHost(identity)) {
    throw fail("host_refused", WRONG_HOST_MESSAGE, {
      status: 403,
      details: {
        allowed: ["Rico.local", "Rico"],
        received: {
          hostname: identity?.hostname || "",
          localHostName: identity?.localHostName || "",
        },
      },
    });
  }
  return {
    hostname: String(identity.hostname ?? ""),
    localHostName: String(identity.localHostName ?? ""),
  };
}
