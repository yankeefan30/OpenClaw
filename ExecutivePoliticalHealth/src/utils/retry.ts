export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableNotionError(err: unknown): boolean {
  const e = err as {
    code?: string;
    status?: number;
    message?: string;
  };
  if (e?.status === 429) return true;
  if (e?.status && e.status >= 500) return true;
  if (e?.code === "rate_limited") return true;
  if (e?.code === "service_unavailable") return true;
  if (typeof e?.message === "string" && /timeout|ECONNRESET|ETIMEDOUT/i.test(e.message)) {
    return true;
  }
  return false;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxAttempts: number;
    baseMs: number;
    label: string;
    onRetry?: (attempt: number, err: unknown) => void;
  },
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableNotionError(err) || attempt === opts.maxAttempts) {
        throw err;
      }
      opts.onRetry?.(attempt, err);
      const delay = opts.baseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 100);
      await sleep(delay);
    }
  }
  throw lastErr;
}
