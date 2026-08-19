import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SCRIPT = path.join(ROOT, "polar-imessage-health.zsh");
export const PLIST = path.join(ROOT, "launchd/ai.polar.imessage-health.plist");

export function zshBin() {
  for (const candidate of [process.env.ZSH, "/bin/zsh", "/usr/bin/zsh", "zsh"]) {
    if (!candidate) continue;
    if (candidate === "zsh") return candidate;
    if (fs.existsSync(candidate)) return candidate;
  }
  return "zsh";
}

export async function makeHarness() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rico-imsg-health-"));
  const bin = path.join(dir, "bin");
  await fs.promises.mkdir(bin);
  const proctab = path.join(dir, "proctab");
  await fs.promises.writeFile(proctab, "", { mode: 0o644 });
  await writeExecutable(path.join(bin, "hostname"), `#!/usr/bin/env bash
echo "\${MOCK_HOSTNAME:-Rico.local}"
`);
  await writeExecutable(path.join(bin, "scutil"), `#!/usr/bin/env bash
if [[ "\${1:-}" == --get && "\${2:-}" == LocalHostName ]]; then
  echo "\${MOCK_LOCAL_HOSTNAME:-Rico}"
  exit 0
fi
exit 1
`);
  await writeExecutable(path.join(bin, "osascript"), `#!/usr/bin/env bash
script=""
if [[ "\${1:-}" == -e ]]; then
  script="\${2:-}"
fi
printf '%s\\n' "\$script" >> "${dir}/osascript.scripts"
if [[ "\$script" == *quit* ]]; then
  exit 0
fi
  if [[ "\$script" == *"get name"* ]]; then
  phase="ok"
  if [[ -f "${dir}/ae_phase" ]]; then
    phase=\$(cat "${dir}/ae_phase")
  fi
  case "\$phase" in
    timeout)
      if [[ -f "${dir}/open.args" ]]; then
        echo "Messages"
        exit 0
      fi
      sleep 30
      exit 0
      ;;
    timeout-sticky)
      sleep 30
      exit 0
      ;;
    fail)
      echo "osascript failed" >&2
      exit 1
      ;;
    *)
      echo "Messages"
      exit 0
      ;;
  esac
fi
echo "unexpected osascript: \$script" >&2
exit 1
`);
  await writeExecutable(path.join(bin, "imsg"), `#!/usr/bin/env bash
printf '%s\\n' "\$*" >> "${dir}/imsg.args"
if [[ "\${1:-}" == --version ]]; then
  echo "\${MOCK_IMSG_VERSION:-0.14.1}"
  exit 0
fi
if [[ "\${1:-}" == --help ]]; then
  echo "imsg help"
  exit 0
fi
echo "imsg mock refused unexpected argv: \$*" >&2
exit 2
`);
  await writeExecutable(path.join(bin, "open"), `#!/usr/bin/env bash
printf '%s\\n' "\$*" >> "${dir}/open.args"
`);
  return {
    dir,
    bin,
    proctab,
    log: path.join(dir, "polar-imessage-health.log"),
    state: path.join(dir, "polar-imessage-health.state.json"),
    async writeProctab(body) {
      await fs.promises.writeFile(proctab, `${body.trim()}\n`, { mode: 0o644 });
    },
    async setPhase(phase) {
      await fs.promises.writeFile(path.join(dir, "ae_phase"), `${phase}\n`);
    },
    async readState() {
      return JSON.parse(await fs.promises.readFile(path.join(dir, "polar-imessage-health.state.json"), "utf8"));
    },
    async readLines(name) {
      const file = path.join(dir, name);
      try {
        return (await fs.promises.readFile(file, "utf8")).split(/\n/u).filter(Boolean);
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
    },
    env(extra = {}) {
      return {
        ...process.env,
        MOCK_HOSTNAME: extra.MOCK_HOSTNAME ?? "Rico.local",
        MOCK_LOCAL_HOSTNAME: extra.MOCK_LOCAL_HOSTNAME ?? "Rico",
        MOCK_IMSG_VERSION: extra.MOCK_IMSG_VERSION ?? "0.14.1",
        HEALTH_BIN_HOSTNAME: path.join(bin, "hostname"),
        HEALTH_BIN_SCUTIL: path.join(bin, "scutil"),
        HEALTH_BIN_OSASCRIPT: path.join(bin, "osascript"),
        HEALTH_BIN_IMSG: extra.HEALTH_BIN_IMSG ?? path.join(bin, "imsg"),
        HEALTH_BIN_OPEN: path.join(bin, "open"),
        POLAR_IHEALTH_LOG: path.join(dir, "polar-imessage-health.log"),
        POLAR_IHEALTH_STATE: path.join(dir, "polar-imessage-health.state.json"),
        POLAR_IHEALTH_PROCTAB: proctab,
        POLAR_IHEALTH_HARNESS_DIR: dir,
        POLAR_IHEALTH_AE_TIMEOUT: extra.POLAR_IHEALTH_AE_TIMEOUT ?? "2",
        POLAR_IHEALTH_QUIT_TIMEOUT: extra.POLAR_IHEALTH_QUIT_TIMEOUT ?? "2",
        POLAR_IHEALTH_START_WAIT: extra.POLAR_IHEALTH_START_WAIT ?? "3",
        POLAR_IHEALTH_HUNG_SEC: extra.POLAR_IHEALTH_HUNG_SEC ?? "25",
        POLAR_IHEALTH_LONG_LIVED_SEC: extra.POLAR_IHEALTH_LONG_LIVED_SEC ?? "172800",
        POLAR_IHEALTH_FAST: extra.POLAR_IHEALTH_FAST ?? "1",
        POLAR_IHEALTH_NOW: extra.POLAR_IHEALTH_NOW ?? "2026-08-19T10:00:00Z",
        ...omitKeys(extra, [
          "MOCK_HOSTNAME",
          "MOCK_LOCAL_HOSTNAME",
          "MOCK_IMSG_VERSION",
          "HEALTH_BIN_IMSG",
          "POLAR_IHEALTH_AE_TIMEOUT",
          "POLAR_IHEALTH_QUIT_TIMEOUT",
          "POLAR_IHEALTH_START_WAIT",
          "POLAR_IHEALTH_HUNG_SEC",
          "POLAR_IHEALTH_LONG_LIVED_SEC",
          "POLAR_IHEALTH_FAST",
          "POLAR_IHEALTH_NOW",
        ]),
      };
    },
  };
}

function omitKeys(object, keys) {
  const copy = { ...object };
  for (const key of keys) delete copy[key];
  return copy;
}

async function writeExecutable(file, body) {
  await fs.promises.writeFile(file, body, { mode: 0o755 });
}

export function runHealth(harness, { args = [], extraEnv = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(zshBin(), [SCRIPT, ...args], {
      env: harness.env(extraEnv),
      cwd: ROOT,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export const HEALTHY_PROCTAB = `
9037 1 01:10:00 /System/Applications/Messages.app/Contents/MacOS/Messages
`.trim();

export const WEDGED_PROCTAB = `
9037 1 03-01:00:00 /System/Applications/Messages.app/Contents/MacOS/Messages
88454 89000 02:01 /usr/bin/osascript
89000 1 02:05 /opt/homebrew/bin/imsg
89073 89000 02:01 /usr/bin/osascript -e tell application "Messages" to get name
555 1 05:00 /usr/bin/osascript -e tell application "Mail" to get name
12 1 00:03 /usr/bin/osascript -e tell application "Messages" to get name
`.trim();

export const IMSG_SEND_PROCTAB = `
9037 1 01:10:00 /System/Applications/Messages.app/Contents/MacOS/Messages
400 1 02:10 /opt/homebrew/bin/imsg send
`.trim();
