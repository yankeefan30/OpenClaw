import { safeVendor } from "./policy.mjs";

export function acknowledgementText(vendor) {
  const label = safeVendor(vendor);
  return label ? `I’m pulling the ${label} receipt now.` : "I’m pulling it now.";
}

export function sentCloseText({ vendor, date, amount }) {
  const label = safeVendor(vendor);
  const subject = label ? `${label} receipt` : "Your receipt";
  const month = monthYear(date);
  if (month) return `${subject} for ${month} is on the way.`;
  const safeAmount = normalizeAmount(amount);
  if (safeAmount) return `${subject} for ${safeAmount} is on the way.`;
  return `${subject} is on the way.`;
}

export function notFoundCloseText({ vendor, locations }) {
  const label = safeVendor(vendor);
  const subject = label ? `the ${label} receipt` : "the receipt";
  return `I couldn’t find ${subject}. I checked ${formatLocations(locations)}.`;
}

export function loginBlockedCloseText(vendor) {
  const label = safeVendor(vendor);
  const subject = label ? `the ${label} receipt` : "the receipt";
  return `I hit a login block while retrieving ${subject}. Alan needs to complete the login.`;
}

export function reviewBlockedCloseText(vendor) {
  const label = safeVendor(vendor);
  const subject = label ? `the ${label} receipt` : "the receipt";
  return `I found more than one possible match for ${subject}. Alan needs to choose the right one.`;
}

export function evidenceBlockedCloseText(vendor) {
  const label = safeVendor(vendor);
  const subject = label ? `the ${label} receipt` : "the receipt";
  return `I couldn’t verify ${subject}. Alan needs to review the receipt.`;
}

export function emailUnknownCloseText(vendor) {
  const label = safeVendor(vendor);
  const subject = label ? `the ${label} receipt` : "the receipt";
  return `I couldn’t confirm whether ${subject} was sent. Alan needs to check Gmail Sent.`;
}

export function formatLocations(locations) {
  const values = [...new Set((locations ?? []).map((item) => String(item).trim()).filter(Boolean))];
  if (values.length === 0) return "the approved locations";
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

export function monthYear(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const iso = /^\d{4}-\d{2}(?:-\d{2})?$/u.test(raw) ? new Date(`${raw.slice(0, 7)}-01T00:00:00Z`) : new Date(raw);
  if (Number.isNaN(iso.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(iso);
}

export function normalizeAmount(value) {
  const raw = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (!raw || raw.length > 32 || !/^(?:(?:USD|EUR|GBP|CAD)\s*)?(?:[$€£]\s*)?\d{1,9}(?:,\d{3})*(?:\.\d{2})?$/iu.test(raw)) return null;
  return raw;
}
