import os from "node:os";
import { fail } from "./errors.mjs";

const ORIGINAL_RICO = new Set(["rico", "rico.local"]);

export function normalizeHostname(hostname) {
  return String(hostname ?? "").trim().toLowerCase().replace(/\.$/u, "");
}

export function isOriginalRicoHost(hostname) {
  return ORIGINAL_RICO.has(normalizeHostname(hostname));
}

export function assertOriginalRicoHost({
  hostname = os.hostname(),
  allowNonRico = process.env.RICO_LINDY_BRIDGE_ALLOW_NON_RICO === "1",
} = {}) {
  if (allowNonRico) return { ok: true, hostname: normalizeHostname(hostname), enforced: false };
  if (!isOriginalRicoHost(hostname)) {
    throw fail("host_refused", "This bridge starts on original Rico.local only. Do not install on Rico 2.");
  }
  return { ok: true, hostname: normalizeHostname(hostname), enforced: true };
}
