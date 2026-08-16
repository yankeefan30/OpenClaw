export class BadRudyError extends Error {
  constructor(code, publicMessage = code, options = {}) {
    super(publicMessage, options);
    this.name = "BadRudyError";
    this.code = normalizeErrorCode(code);
    this.publicMessage = String(publicMessage || code);
  }
}

export function codedError(code, message = code, cause) {
  return new BadRudyError(code, message, cause === undefined ? {} : { cause });
}

export function safeError(error) {
  const code = normalizeErrorCode(error?.code ?? error?.name ?? "bad_rudy_unavailable");
  const known = error instanceof BadRudyError;
  return Object.freeze({
    code,
    message: known ? error.publicMessage : "Bad Rudy is unavailable. Review the local status details and try again.",
  });
}

function normalizeErrorCode(value) {
  return String(value ?? "bad_rudy_unavailable")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "_")
    .slice(0, 96) || "bad_rudy_unavailable";
}
