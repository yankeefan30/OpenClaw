export class GovernedError extends Error {
  constructor(code, message, { retryable = false, details = undefined } = {}) {
    super(message);
    this.name = "GovernedError";
    this.code = code;
    this.retryable = Boolean(retryable);
    this.details = details;
  }
}

export function governed(code, message, options) {
  return new GovernedError(code, message, options);
}

export function publicError(error) {
  if (error instanceof GovernedError) {
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
    message: "The governed OpenTable operation failed closed.",
    retryable: false,
  };
}
