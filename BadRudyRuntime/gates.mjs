import { REQUIRED_WORKER_CAPABILITY } from "./config.mjs";
import { codedError } from "./errors.mjs";

export async function runtimeStatus({ config, credentialProvider, worker, reviewedDelivery, rateLimitAuthority }) {
  const [keychain, workerRaw, deliveryRaw, rateRaw] = await Promise.all([
    safeProbe(credentialProvider, "status", { available: false, code: "keychain_provider_unavailable" }),
    safeProbe(worker, "health", { ready: false, code: "worker_health_failed" }),
    safeProbe(reviewedDelivery, "health", { ready: false, code: "reviewed_delivery_unavailable" }),
    safeProbe(rateLimitAuthority, "health", { ready: false, code: "rate_limit_authority_unavailable" }),
  ]);
  const workerCapability = workerRaw?.capabilities?.[REQUIRED_WORKER_CAPABILITY] === true;
  const workerReady = workerRaw?.ready === true && workerRaw?.playwright === "ready" && workerRaw?.ffmpeg === "ready" && workerCapability;
  const keychainReady = keychain?.available === true;
  const allowlistReady = config.allowedRecipients.length > 0;
  const killSwitchOff = config.killSwitch === false;
  const deliveryReady = reviewedDelivery != null && deliveryRaw?.ready === true;
  const rateReady = rateLimitAuthority != null && rateRaw?.ready === true &&
    typeof rateRaw?.policyVersion === "string" && rateRaw.policyVersion.trim() !== "" &&
    validRevision(rateRaw?.revision);
  const reasons = [];
  if (!keychainReady) reasons.push("keychain_missing");
  if (!killSwitchOff) reasons.push("kill_switch_on");
  if (!allowlistReady) reasons.push("allowlist_empty");
  if (workerRaw?.ready !== true || workerRaw?.playwright !== "ready" || workerRaw?.ffmpeg !== "ready") reasons.push("playwright_worker_down");
  if (!workerCapability) reasons.push("bad_rudy_web_capability_unavailable");
  if (!rateReady) reasons.push("rate_limit_authority_unavailable");
  if (!deliveryReady) reasons.push("reviewed_delivery_unavailable");
  return Object.freeze({
    keychain: Object.freeze({ ready: keychainReady, code: keychainReady ? "ok" : String(keychain?.code ?? "keychain_missing") }),
    worker: Object.freeze({ ready: workerReady, capability: workerCapability, code: workerReady ? "ok" : String(workerRaw?.code ?? "worker_down") }),
    dryRun: config.dryRun,
    killSwitch: config.killSwitch,
    allowlistCount: config.allowedRecipients.length,
    reviewedDelivery: Object.freeze({ ready: deliveryReady, code: deliveryReady ? "ok" : String(deliveryRaw?.code ?? "reviewed_delivery_unavailable") }),
    rateLimits: Object.freeze({
      ready: rateReady,
      code: rateReady ? "ok" : String(rateRaw?.code ?? "rate_limit_authority_unavailable"),
      policyVersion: rateReady ? rateRaw.policyVersion : null,
      revision: rateReady ? String(rateRaw.revision) : null,
    }),
    captureReady: reasons.filter((reason) => reason !== "reviewed_delivery_unavailable").length === 0,
    sendReady: reasons.length === 0 && config.dryRun === false,
    reasons: Object.freeze(reasons),
  });
}

function validRevision(value) {
  return (Number.isInteger(value) && value >= 0) || (typeof value === "string" && value.trim() !== "" && value.length <= 120);
}

async function safeProbe(target, method, fallback) {
  try {
    if (!target || typeof target[method] !== "function") return fallback;
    const result = await target[method]();
    return result && typeof result === "object" ? result : fallback;
  } catch {
    return fallback;
  }
}

export function assertCaptureReady(status) {
  if (status.captureReady === true) return;
  const code = status.reasons[0] ?? "bad_rudy_unavailable";
  const messages = {
    keychain_missing: "Grok credentials are missing from macOS Keychain.",
    kill_switch_on: "Bad Rudy's kill switch is on.",
    allowlist_empty: "Rico's approved-recipient allowlist is empty.",
    playwright_worker_down: "The bounded Playwright worker or ffmpeg is not ready.",
    bad_rudy_web_capability_unavailable: "The worker cannot verify Grok Companions → Bad Rudy on the web. No substitute video path is allowed.",
    rate_limit_authority_unavailable: "Rico's existing global and per-recipient rate-limit authority is unavailable.",
  };
  throw codedError(code, messages[code] ?? "Bad Rudy is unavailable.");
}

export function assertSendReady(status, { allowDryRun = false } = {}) {
  assertCaptureReady(status);
  if (status.reviewedDelivery.ready !== true) throw codedError("reviewed_delivery_unavailable", "Rico's reviewed attachment send boundary is unavailable.");
  if (!allowDryRun && status.dryRun) throw codedError("dry_run_on", "Dry-run is on; Bad Rudy will not send.");
}
