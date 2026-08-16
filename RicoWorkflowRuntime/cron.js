import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const OPENCLAW = "/opt/homebrew/bin/openclaw";

function agentMessage(plan) {
  if (plan.payload.type === "exact_text") {
    return [
      "Rico scheduled-text job. Do not invent extra commentary.",
      `Send this exact iMessage to ${plan.recipient} and nothing else:`,
      plan.payload.text,
    ].join("\n");
  }
  return [
    "Rico scheduled-agent job. Stay inside the reviewed iMessage allowlist.",
    "Deliver one concise iMessage, then stop.",
    plan.payload.prompt,
  ].join("\n");
}

export async function installCron(plan) {
  const args = [
    "cron", "add",
    "--json",
    "--name", plan.name,
    "--session", "isolated",
    "--light-context",
    "--expect-final",
    "--announce",
    "--channel", "imessage",
    "--to", plan.recipient,
    "--message", agentMessage(plan),
    "--timeout-seconds", "90",
  ];
  if (plan.schedule.type === "at") {
    args.push("--at", plan.schedule.at, "--delete-after-run");
  } else {
    args.push("--cron", plan.schedule.expr, "--tz", plan.schedule.tz || "America/New_York", "--exact");
  }
  const { stdout } = await execFileAsync(OPENCLAW, args, { timeout: 30_000 });
  const parsed = JSON.parse(String(stdout ?? "{}"));
  const id = parsed.id ?? parsed.job?.id ?? parsed.jobId;
  if (!id) throw new Error("OpenClaw cron did not return a job id.");
  return { cronId: String(id), raw: parsed };
}

export async function removeCron(cronId) {
  await execFileAsync(OPENCLAW, ["cron", "rm", String(cronId), "--json"], { timeout: 20_000 });
}
