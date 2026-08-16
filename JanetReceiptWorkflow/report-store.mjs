import fs from "node:fs";
import path from "node:path";
import { defaultStateDirectory, ensurePrivateDirectory } from "./grant.mjs";

export class FileReportStore {
  constructor(directory = path.join(defaultStateDirectory(), "reports")) {
    this.directory = path.resolve(directory);
  }

  async record(report) {
    validateReport(report);
    ensurePrivateDirectory(this.directory);
    const target = path.join(this.directory, `${report.requestKey}.json`);
    if (fs.existsSync(target)) throw new Error("request report already exists");
    const temporary = path.join(this.directory, `.${report.requestKey}.${process.pid}.tmp`);
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, target);
      fs.chmodSync(target, 0o600);
      return { ok: true };
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
}

function validateReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error("report must be an object");
  if (report.schema !== "rico.janet-receipt-report" || report.schemaVersion !== 2) throw new Error("report envelope is invalid");
  if (!/^[a-f0-9]{64}$/u.test(String(report.requestKey ?? ""))) throw new Error("report requestKey is invalid");
  if (!/^(?:sent|not_found|blocked_login|blocked_ambiguous|blocked_evidence|blocked_signature|email_outcome_unknown|failed)$/u.test(String(report.outcome ?? ""))) {
    throw new Error("report outcome is invalid");
  }
  if (typeof report.reason !== "string" || report.reason.length > 160) throw new Error("report reason is invalid");
  const serialized = JSON.stringify(report);
  if (/"(?:password|passcode|secret|accessToken|refreshToken|apiKey|authorization)"\s*:/iu.test(serialized)) {
    throw new Error("report contains a forbidden credential field");
  }
  if (Buffer.byteLength(serialized, "utf8") > 32 * 1024) throw new Error("report exceeds 32 KB");
}
