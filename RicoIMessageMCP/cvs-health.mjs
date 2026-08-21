export const CVS_HEALTH_MAIL_EMAIL = "alan.rosa@cvshealth.com";
export const CVS_HEALTH_MAIL_DOMAIN = "cvshealth.com";
export const CVS_HEALTH_ACCOUNT_LABEL = "CVS Health";

const CVS_LABEL = CVS_HEALTH_ACCOUNT_LABEL.toLowerCase();

export function isCvsHealthMailAccount(account) {
  const name = normalizeName(account?.name);
  if (name === CVS_LABEL || name === CVS_HEALTH_MAIL_EMAIL) return true;
  const emails = Array.isArray(account?.emails) ? account.emails : [];
  return emails.some((email) => isCvsHealthEmail(email));
}

export function isCvsHealthCalendar(calendar) {
  const name = normalizeName(calendar?.name);
  const account = normalizeName(calendar?.account);
  if (account === CVS_LABEL || account.includes("cvshealth") || account === CVS_HEALTH_MAIL_EMAIL) {
    return true;
  }
  return name === CVS_LABEL || name.includes("cvshealth");
}

export function pickCvsHealthMailAccount(accounts) {
  const matches = (Array.isArray(accounts) ? accounts : []).filter(isCvsHealthMailAccount);
  if (matches.length === 0) return null;
  return matches.find((account) => normalizeName(account.name) === CVS_HEALTH_MAIL_EMAIL)
    || matches.find((account) => normalizeName(account.name) === CVS_LABEL)
    || matches.find((account) => (account.emails ?? []).some((email) => normalizeName(email) === CVS_HEALTH_MAIL_EMAIL))
    || matches[0];
}

export function pickCvsHealthCalendar(calendars) {
  const matches = (Array.isArray(calendars) ? calendars : []).filter(isCvsHealthCalendar);
  if (matches.length === 0) return null;
  return matches.find((calendar) => normalizeName(calendar.name) === "calendar" && isCvsHealthCalendar(calendar))
    || matches.find((calendar) => normalizeName(calendar.name) === CVS_LABEL)
    || matches.find((calendar) => calendar.writable !== false)
    || matches[0];
}

export function publicMailAccount(account) {
  return {
    name: String(account.name ?? "").slice(0, 80),
    kind: String(account.kind ?? "").slice(0, 32),
    cvsHealth: isCvsHealthMailAccount(account) === true,
  };
}

export function publicCalendar(calendar) {
  return {
    name: String(calendar.name ?? "").slice(0, 80),
    account: calendar.account ? String(calendar.account).slice(0, 80) : "",
    writable: calendar.writable === true,
    cvsHealth: isCvsHealthCalendar(calendar) === true,
  };
}

function isCvsHealthEmail(value) {
  const email = normalizeName(value);
  return email === CVS_HEALTH_MAIL_EMAIL || email.endsWith(`@${CVS_HEALTH_MAIL_DOMAIN}`);
}

function normalizeName(value) {
  return String(value ?? "").trim().toLowerCase();
}
