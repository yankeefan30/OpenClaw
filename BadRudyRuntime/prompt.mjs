import { codedError } from "./errors.mjs";

export const PROMPT_SOFT_CAP = 500;
export const PROMPT_HARD_CAP = 2_000;

export async function validatePrompt(input, promptFilter) {
  const prompt = String(input ?? "").trim();
  if (!prompt) throw codedError("prompt_required", "Tell Bad Rudy what to say or do.");
  if ([...prompt].length > PROMPT_HARD_CAP) throw codedError("prompt_too_long", "Bad Rudy prompts cannot exceed 2,000 characters.");
  if (!promptFilter || typeof promptFilter.evaluate !== "function") throw codedError("prompt_filter_unavailable", "The existing OpenClaw prompt safety filter is unavailable.");
  const decision = await promptFilter.evaluate(prompt, { feature: "bad-rudy", source: "human:studio" });
  if (decision?.allow !== true) throw codedError("prompt_rejected", String(decision?.publicReason || "The prompt did not pass OpenClaw's safety review."));
  const policyVersion = String(decision?.policyVersion ?? "").trim();
  if (!policyVersion || policyVersion.length > 120) throw codedError("prompt_filter_unavailable", "The existing OpenClaw prompt safety filter did not return a policy version.");
  return Object.freeze({ prompt, policyVersion, softCapExceeded: [...prompt].length > PROMPT_SOFT_CAP });
}

export function assertHumanCaptureSource(source) {
  const value = String(source ?? "human:studio");
  if (value === "grok:bad-rudy" || value.startsWith("capture:")) {
    throw codedError("capture_loop_blocked", "A captured clip cannot trigger another Bad Rudy capture.");
  }
  if (value !== "human:studio") throw codedError("capture_source_untrusted", "Bad Rudy captures must start from the Studio prompt box.");
}
