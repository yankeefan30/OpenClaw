export class BridgeError extends Error {
  constructor(code, message, { retryable = false, status = 400 } = {}) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.retryable = Boolean(retryable);
    this.status = status;
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
    };
  }
  return {
    ok: false,
    error: "internal_error",
    message: "The Rico iMessage bridge failed closed.",
    retryable: false,
  };
}
