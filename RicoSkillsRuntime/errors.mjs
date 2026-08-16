export class RicoSkillError extends Error {
  constructor(code, message, detail = undefined) {
    super(message);
    this.name = "RicoSkillError";
    this.code = code;
    this.detail = detail;
  }

  toJSON() {
    return { code: this.code, message: this.message, ...(this.detail ? { detail: this.detail } : {}) };
  }
}

export function invariant(condition, code, message, detail) {
  if (!condition) throw new RicoSkillError(code, message, detail);
}
