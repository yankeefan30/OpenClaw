import { createHash } from "node:crypto";
import { monthYear, normalizeAmount } from "./messages.mjs";
import { normalizeHttpsOrigin, safeVendor, sha256 } from "./policy.mjs";

const MAX_PDF_BYTES = 25 * 1024 * 1024;

export class PdfEvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PdfEvidenceError";
    this.code = code;
  }
}

export function verifyReceiptEvidence(candidate, { location, expectedOrigin }) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new PdfEvidenceError("pdf_missing", "Receipt search did not return one candidate.");
  }
  if (String(candidate.sourceLocation ?? "").trim() !== location) {
    throw new PdfEvidenceError("source_location", "Receipt candidate came from an unexpected location.");
  }
  if (String(candidate.mimeType ?? "").toLowerCase() !== "application/pdf") {
    throw new PdfEvidenceError("pdf_mime", "Receipt evidence MIME type is not application/pdf.");
  }
  const fileName = String(candidate.fileName ?? "").trim();
  if (!/\.pdf$/iu.test(fileName) || fileName.length > 180 || /[/\\\u0000]/u.test(fileName)) {
    throw new PdfEvidenceError("pdf_filename", "Receipt evidence needs a safe .pdf filename.");
  }
  const bytes = toBuffer(candidate.bytes);
  if (bytes.length < 12 || bytes.length > MAX_PDF_BYTES) {
    throw new PdfEvidenceError("pdf_size", "Receipt PDF size is outside the allowed range.");
  }
  if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-", "ascii"))) {
    throw new PdfEvidenceError("pdf_magic", "Receipt evidence does not have a PDF header.");
  }
  const trailer = bytes.subarray(Math.max(0, bytes.length - 2048)).toString("latin1");
  if (!/%EOF\s*$/u.test(trailer)) {
    throw new PdfEvidenceError("pdf_trailer", "Receipt evidence does not have a terminal PDF marker.");
  }

  if (expectedOrigin) {
    const sourceOrigin = sourceUrlOrigin(candidate.sourceUrl);
    if (!sourceOrigin || sourceOrigin !== normalizeHttpsOrigin(expectedOrigin)) {
      throw new PdfEvidenceError("pdf_origin", "Portal receipt evidence came from an unexpected origin.");
    }
  }
  const sourceRecordId = String(candidate.sourceRecordId ?? "").trim();
  if (!sourceRecordId || sourceRecordId.length > 256) {
    throw new PdfEvidenceError("source_record_id", "Receipt evidence needs a stable source record identifier.");
  }

  const metadata = candidate.metadata && typeof candidate.metadata === "object" ? candidate.metadata : candidate;
  const vendor = safeVendor(metadata.vendor);
  const amount = normalizeAmount(metadata.amount);
  const date = normalizeDate(metadata.date);
  if (!vendor) throw new PdfEvidenceError("vendor_missing", "Receipt evidence needs an extracted vendor.");
  if (!amount) throw new PdfEvidenceError("amount_missing", "Receipt evidence needs an extracted amount.");
  // Date can be unavailable on some receipts; the deterministic close text then
  // uses amount. A supplied but invalid date is never silently discarded.
  if (metadata.date !== undefined && metadata.date !== null && !date) {
    throw new PdfEvidenceError("date_invalid", "Receipt evidence has an invalid extracted date.");
  }

  const pdfSha256 = createHash("sha256").update(bytes).digest("hex");
  return Object.freeze({
    attachment: Object.freeze({ fileName, mimeType: "application/pdf", bytes }),
    metadata: Object.freeze({ vendor, amount, date, monthYear: monthYear(date) }),
    evidence: Object.freeze({
      pdfSha256,
      pdfBytes: bytes.length,
      sourceRecordIdHash: sha256(sourceRecordId),
      sourceLocationHash: sha256(location),
      vendorHash: sha256(vendor),
      amountHash: sha256(amount),
      dateHash: sha256(date ?? "missing"),
    }),
  });
}

function normalizeDate(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(raw)) return null;
  const parsed = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw ? raw : null;
}

function sourceUrlOrigin(value) {
  try {
    return normalizeHttpsOrigin(new URL(String(value ?? "")).origin);
  } catch {
    return "";
  }
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new PdfEvidenceError("pdf_bytes", "Receipt evidence needs binary PDF bytes.");
}
