export class BridgeError extends Error {
  constructor(code, message, { retryable = false, status = 400, details } = {}) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.retryable = Boolean(retryable);
    this.status = status;
    this.details = details;
  }
}

export function fail(code, message, options) {
  return new BridgeError(code, message, options);
}

export function publicError(error) {
  if (error instanceof BridgeError) {
    return {
      ok: false,
      error: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  return {
    ok: false,
    error: "internal_error",
    message: "The Rico Pressmaster MCP failed closed.",
    retryable: false,
  };
}

export function scrubSecrets(value, secrets = []) {
  if (value == null) return value;
  let text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4) {
      text = text.split(secret).join("[redacted]");
    }
  }
  return text;
}
