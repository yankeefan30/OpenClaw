export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Safe logger — never dumps secrets or full email bodies. */
export class Logger {
  private level: LogLevel;

  constructor(level: LogLevel = "info") {
    this.level = level;
  }

  private should(level: LogLevel): boolean {
    return LEVEL_RANK[level] >= LEVEL_RANK[this.level];
  }

  private emit(level: LogLevel, message: string, meta?: Record<string, unknown>) {
    if (!this.should(level)) return;
    const safeMeta = meta ? redactMeta(meta) : undefined;
    const line = {
      ts: new Date().toISOString(),
      level,
      message,
      ...(safeMeta ? { meta: safeMeta } : {}),
    };
    const out = JSON.stringify(line);
    if (level === "error") console.error(out);
    else console.log(out);
  }

  debug(message: string, meta?: Record<string, unknown>) {
    this.emit("debug", message, meta);
  }
  info(message: string, meta?: Record<string, unknown>) {
    this.emit("info", message, meta);
  }
  warn(message: string, meta?: Record<string, unknown>) {
    this.emit("warn", message, meta);
  }
  error(message: string, meta?: Record<string, unknown>) {
    this.emit("error", message, meta);
  }
}

const SENSITIVE_KEYS = /token|secret|password|authorization|email_body|transcript|raw_content/i;

function redactMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (SENSITIVE_KEYS.test(k)) {
      out[k] = "[redacted]";
    } else if (typeof v === "string" && v.length > 500) {
      out[k] = `${v.slice(0, 200)}…[truncated ${v.length} chars]`;
    } else {
      out[k] = v;
    }
  }
  return out;
}
