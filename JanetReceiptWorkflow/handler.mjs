import { randomUUID } from "node:crypto";
import {
  acknowledgementText,
  emailUnknownCloseText,
  evidenceBlockedCloseText,
  loginBlockedCloseText,
  notFoundCloseText,
  normalizeAmount,
  reviewBlockedCloseText,
  sentCloseText,
} from "./messages.mjs";
import { PdfEvidenceError, verifyReceiptEvidence } from "./pdf-evidence.mjs";
import { normalizeEmail, parseInboundRequest, sha256, validatePermissionGrant, WorkflowPolicyError } from "./policy.mjs";

const LOGIN_BLOCKS = new Set(["login_required", "two_factor_required", "captcha_required"]);

export async function runJanetReceiptWorkflow({
  event,
  permissionGrant,
  ledger,
  services,
  reporter,
  now = new Date(),
}) {
  const grant = validatePermissionGrant(permissionGrant);
  let request;
  try {
    request = parseInboundRequest(event, grant, now);
  } catch (error) {
    if (error instanceof WorkflowPolicyError) return Object.freeze({ handled: false, status: "ignored", reason: error.code });
    throw error;
  }
  assertDependencies(ledger, services, reporter);

  const suppliedRunId = String(event.runId ?? "").trim();
  const runId = /^[A-Za-z0-9:._-]{1,128}$/u.test(suppliedRunId) ? suppliedRunId : randomUUID();
  const at = () => new Date().toISOString();
  const claimed = ledger.claim({
    requestKey: request.requestKey,
    runId,
    at: at(),
    record: {
      chat_guid: request.chatGuid,
      message_ts: request.messageTs,
      vendor: request.vendorHint,
      run_at: request.runAt,
      request_hash: request.requestKey,
    },
    evidence: { alias: request.alias, senderFingerprint: request.senderFingerprint },
  });
  if (!claimed) return Object.freeze({ handled: true, status: "duplicate", requestKey: request.requestKey });

  const browserSessions = new Set();
  const checkedLocations = [];
  let searchAttempted = false;
  let emailConfirmed = false;
  let finishPromise;
  let result = workflowResult("failed", "failed", "workflow_unexpected", request.vendorHint, null, null);

  try {
    const ack = await services.imessage.replyInThread(threadReply({
      event,
      request,
      to: grant.janetHandle,
      text: acknowledgementText(request.vendorHint),
      phase: "ack",
    }));
    if (ack?.ok !== true) throw codedError("ack_failed", "Same-thread acknowledgement was not confirmed.");
    ledger.append({
      requestKey: request.requestKey,
      runId,
      transition: "acknowledged",
      at: at(),
      evidence: { outcome: "confirmed" },
    });

    searchAttempted = true;
    const search = await searchExactRoute({ request, grant, services, browserSessions, checkedLocations });
    if (search.kind === "login_block") {
      result = workflowResult("handoff", "blocked_login", search.status, request.vendorHint, null, loginBlockedCloseText(request.vendorHint));
      return await finish();
    }
    if (search.kind === "ambiguous") {
      result = workflowResult("handoff", "blocked_ambiguous", "receipt_ambiguous", request.vendorHint, null, reviewBlockedCloseText(request.vendorHint));
      return await finish();
    }
    if (search.kind === "not_found") {
      result = workflowResult(
        "closed",
        "not_found",
        "receipt_not_found",
        request.vendorHint,
        null,
        notFoundCloseText({ vendor: request.vendorHint, locations: checkedLocations }),
      );
      return await finish();
    }
    if (search.kind !== "found") {
      result = workflowResult("handoff", "failed", "search_unavailable", request.vendorHint, null, evidenceBlockedCloseText(request.vendorHint));
      return await finish();
    }

    let verified;
    try {
      verified = verifyReceiptEvidence(search.candidate, {
        location: search.location,
        expectedOrigin: search.expectedOrigin,
      });
      assertEvidenceMatchesRequest(verified.metadata, request);
    } catch (error) {
      result = workflowResult(
        "handoff",
        "blocked_evidence",
        error instanceof PdfEvidenceError ? error.code : "evidence_invalid",
        request.vendorHint,
        null,
        evidenceBlockedCloseText(request.vendorHint),
        { errorCode: safeErrorCode(error) },
      );
      return await finish();
    }
    ledger.append({
      requestKey: request.requestKey,
      runId,
      transition: "evidence_verified",
      at: at(),
      evidence: verified.evidence,
    });

    const signature = await fetchExactSignature(services.gmail, grant);
    if (!signature) {
      result = workflowResult(
        "handoff",
        "blocked_signature",
        "gmail_signature_unavailable",
        verified.metadata.vendor,
        verified.metadata,
        evidenceBlockedCloseText(verified.metadata.vendor),
      );
      return await finish();
    }
    ledger.append({
      requestKey: request.requestKey,
      runId,
      transition: "signature_fetched",
      at: at(),
      evidence: { fromFingerprint: sha256(grant.alanGmailSender), signatureHash: sha256(signature.content) },
    });

    const reserved = ledger.reserveEmail({
      requestKey: request.requestKey,
      runId,
      at: at(),
      evidence: {
        fromFingerprint: sha256(grant.alanGmailSender),
        recipientFingerprint: sha256(grant.janetEmailRecipient),
        pdfSha256: verified.evidence.pdfSha256,
      },
    });
    if (!reserved) {
      result = workflowResult(
        "handoff",
        "email_outcome_unknown",
        "email_already_reserved",
        verified.metadata.vendor,
        verified.metadata,
        emailUnknownCloseText(verified.metadata.vendor),
      );
      return await finish();
    }

    let email;
    try {
      email = await services.gmail.sendReceipt({
        accountRef: grant.capabilityRefs.alanGmail,
        from: grant.alanGmailSender,
        to: grant.janetEmailRecipient,
        cc: [],
        bcc: [],
        subject: receiptSubject(verified.metadata),
        text: "Attached is the requested receipt.",
        signature,
        attachment: verified.attachment,
        idempotencyKey: `${request.requestKey}:email`,
      });
    } catch (error) {
      safeAppend(ledger, {
        requestKey: request.requestKey,
        runId,
        transition: "email_outcome_unknown",
        at: at(),
        evidence: { errorCode: safeErrorCode(error), recipientFingerprint: sha256(grant.janetEmailRecipient) },
      });
      result = workflowResult(
        "handoff",
        "email_outcome_unknown",
        "email_outcome_unknown",
        verified.metadata.vendor,
        verified.metadata,
        emailUnknownCloseText(verified.metadata.vendor),
      );
      return await finish();
    }
    if (email?.ok !== true || normalizeEmail(email.from) !== grant.alanGmailSender || normalizeEmail(email.to) !== grant.janetEmailRecipient) {
      safeAppend(ledger, {
        requestKey: request.requestKey,
        runId,
        transition: "email_outcome_unknown",
        at: at(),
        evidence: { errorCode: safeErrorCode(email?.error), recipientFingerprint: sha256(grant.janetEmailRecipient) },
      });
      result = workflowResult(
        "handoff",
        "email_outcome_unknown",
        "email_outcome_unknown",
        verified.metadata.vendor,
        verified.metadata,
        emailUnknownCloseText(verified.metadata.vendor),
      );
      return await finish();
    }
    emailConfirmed = true;
    safeAppend(ledger, {
      requestKey: request.requestKey,
      runId,
      transition: "email_sent",
      at: at(),
      evidence: {
        outcome: "confirmed",
        fromFingerprint: sha256(grant.alanGmailSender),
        recipientFingerprint: sha256(grant.janetEmailRecipient),
        providerMessageIdHash: sha256(String(email.messageId ?? "confirmed-without-provider-id")),
      },
    });
    result = workflowResult(
      "completed",
      "sent",
      "receipt_emailed",
      verified.metadata.vendor,
      verified.metadata,
      sentCloseText(verified.metadata),
      verified.evidence,
    );
    return await finish();
  } catch (error) {
    result = workflowResult(
      "handoff",
      emailConfirmed ? "sent" : "failed",
      emailConfirmed ? "post_email_internal_failure" : safeErrorCode(error),
      result.vendor ?? request.vendorHint,
      result.metadata,
      emailConfirmed ? sentCloseText(result.metadata ?? { vendor: result.vendor }) : evidenceBlockedCloseText(result.vendor ?? request.vendorHint),
      { ...result.evidence, errorCode: safeErrorCode(error) },
    );
    return await finish();
  }

  function finish() {
    finishPromise ??= performFinish();
    return finishPromise;
  }

  async function performFinish() {
    if (searchAttempted) {
      try {
        const closed = await services.receipts.closeSessions({
          requestKey: request.requestKey,
          sessionIds: [...browserSessions],
        });
        if (closed?.ok !== true) throw codedError("browser_close_failed", "Receipt search sessions were not confirmed closed.");
        safeAppend(ledger, {
          requestKey: request.requestKey,
          runId,
          transition: "search_sessions_closed",
          at: at(),
          evidence: { outcome: "confirmed", sessionIdHash: sha256([...browserSessions].sort().join("\u0000") || request.requestKey) },
        });
      } catch (error) {
        result = { ...result, evidence: { ...result.evidence, errorCode: safeErrorCode(error) } };
      }
    }

    if (result.closeText) {
      try {
        const closedThread = await services.imessage.replyInThread(threadReply({
          event,
          request,
          to: grant.janetHandle,
          text: result.closeText,
          phase: "close",
        }));
        if (closedThread?.ok !== true) throw codedError("thread_close_failed", "Same-thread close reply was not confirmed.");
        safeAppend(ledger, {
          requestKey: request.requestKey,
          runId,
          transition: "thread_closed",
          at: at(),
          evidence: { outcome: result.ledgerOutcome },
        });
      } catch (error) {
        result = { ...result, evidence: { ...result.evidence, errorCode: safeErrorCode(error) } };
      }
    }

    const report = {
      schema: "rico.janet-receipt-report",
      schemaVersion: 2,
      requestKey: request.requestKey,
      runId,
      chat_guid: request.chatGuid,
      message_ts: request.messageTs,
      vendor: result.vendor,
      amount: result.metadata?.amount ?? null,
      date: result.metadata?.date ?? null,
      outcome: result.ledgerOutcome,
      run_at: request.runAt,
      checkedLocations: [...checkedLocations],
      reason: result.reason,
      evidence: result.evidence,
    };
    try {
      await reporter.record(report);
    } catch (error) {
      safeAppend(ledger, {
        requestKey: request.requestKey,
        runId,
        transition: "report_failed",
        at: at(),
        evidence: { errorCode: safeErrorCode(error), outcome: result.ledgerOutcome },
      });
    }
    try {
      ledger.finalize({
        requestKey: request.requestKey,
        runId,
        at: at(),
        vendor: result.vendor,
        outcome: result.ledgerOutcome,
        evidence: { reason: result.reason, locationsHash: sha256(checkedLocations.join("\u0000")) },
      });
    } catch (error) {
      result = { ...result, status: "handoff", reason: "ledger_finalize_failed", evidence: { ...result.evidence, errorCode: safeErrorCode(error) } };
    }
    return Object.freeze({
      handled: true,
      requestKey: request.requestKey,
      status: result.status,
      reason: result.reason,
      outcome: result.ledgerOutcome,
      vendor: result.vendor,
      metadata: result.metadata,
      checkedLocations: Object.freeze([...checkedLocations]),
      evidence: Object.freeze({ ...result.evidence }),
    });
  }
}

export function createInboundClaimHandler(dependencies) {
  return async function inboundClaim(event) {
    const result = await runJanetReceiptWorkflow({ ...dependencies, event });
    return result.handled ? { handled: true } : undefined;
  };
}

async function searchExactRoute({ request, grant, services, browserSessions, checkedLocations }) {
  const steps = routeSteps(request, grant, services);
  for (const step of steps) {
    checkedLocations.push(step.location);
    let response;
    try {
      response = await step.search({
        capabilityRef: step.capabilityRef,
        exactOrigin: step.expectedOrigin,
        query: {
          vendor: request.vendorHint,
          amount: request.amountHint,
          date: request.dateHint,
          untrustedText: request.requestText,
        },
        requestKey: request.requestKey,
      });
    } catch (error) {
      return { kind: "unavailable", error };
    }
    const sessionId = String(response?.sessionId ?? "").trim();
    if (sessionId) browserSessions.add(sessionId);
    if (LOGIN_BLOCKS.has(response?.status)) return { kind: "login_block", status: response.status };
    if (response?.status === "not_found") continue;
    if (response?.status !== "ok" || !Array.isArray(response.matches)) return { kind: "unavailable" };
    if (response.matches.length === 0) continue;
    if (response.matches.length !== 1) return { kind: "ambiguous", matchCount: response.matches.length };
    return {
      kind: "found",
      candidate: response.matches[0],
      location: step.location,
      expectedOrigin: step.expectedOrigin,
    };
  }
  return { kind: "not_found" };
}

function routeSteps(request, grant, services) {
  if (request.route === "opencase") {
    return [{
      location: "OpenCase portal",
      capabilityRef: grant.capabilityRefs.openCaseSession,
      expectedOrigin: grant.openCaseOrigin,
      search: services.receipts.openCase.search,
    }];
  }
  if (request.route === "heygen") {
    return [{
      location: "Heygen portal",
      capabilityRef: grant.capabilityRefs.heygenSession,
      expectedOrigin: grant.heygenOrigin,
      search: services.receipts.heygen.search,
    }];
  }
  return [
    { location: "Genius Scan", capabilityRef: grant.capabilityRefs.geniusScan, search: services.receipts.geniusScan.search },
    { location: "Alan Gmail", capabilityRef: grant.capabilityRefs.alanGmail, search: services.receipts.alanGmail.search },
    { location: "CVS Outlook", capabilityRef: grant.capabilityRefs.cvsOutlook, search: services.receipts.cvsOutlook.search },
  ];
}

async function fetchExactSignature(gmail, grant) {
  let response;
  try {
    response = await gmail.getSendAsSignature({
      accountRef: grant.capabilityRefs.alanGmail,
      from: grant.alanGmailSender,
    });
  } catch {
    return null;
  }
  if (response?.ok !== true || normalizeEmail(response.from) !== grant.alanGmailSender) return null;
  const content = String(response.content ?? "");
  const format = String(response.format ?? "plain").toLowerCase();
  if (!content.trim() || Buffer.byteLength(content, "utf8") > 16 * 1024 || !["plain", "html"].includes(format)) return null;
  return Object.freeze({ content, format });
}

function threadReply({ event, request, to, text, phase }) {
  return {
    chatGuid: request.chatGuid,
    messageTs: request.messageTs,
    sessionKey: String(event.sessionKey ?? "").trim() || undefined,
    threadId: event.threadId,
    to,
    text,
    phase,
    idempotencyKey: `${request.requestKey}:${phase}`,
  };
}

function receiptSubject(metadata) {
  const period = metadata.monthYear ?? metadata.amount;
  return period ? `${metadata.vendor} receipt — ${period}` : `${metadata.vendor} receipt`;
}

function assertEvidenceMatchesRequest(metadata, request) {
  if (request.vendorHint && canonicalVendor(metadata.vendor) !== canonicalVendor(request.vendorHint)) {
    throw new PdfEvidenceError("vendor_mismatch", "Receipt vendor does not match the requested vendor.");
  }
  if (request.amountHint && canonicalAmount(metadata.amount) !== canonicalAmount(request.amountHint)) {
    throw new PdfEvidenceError("amount_mismatch", "Receipt amount does not match the requested amount.");
  }
  if (request.dateHint && !dateHintMatches(metadata.date, request.dateHint)) {
    throw new PdfEvidenceError("date_mismatch", "Receipt date does not match the requested date or month.");
  }
}

function canonicalVendor(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function canonicalAmount(value) {
  const normalized = normalizeAmount(value);
  if (!normalized) return null;
  let compact = normalized.toUpperCase().replace(/[\s,]/gu, "");
  let prefix = "";
  for (const currency of ["USD", "EUR", "GBP", "CAD"]) {
    if (compact.startsWith(currency)) {
      prefix = currency;
      compact = compact.slice(currency.length);
      break;
    }
  }
  const symbol = compact[0];
  const symbolCurrency = symbol === "$" ? "USD" : symbol === "€" ? "EUR" : symbol === "£" ? "GBP" : "";
  if (symbolCurrency) compact = compact.slice(1);
  if (prefix && symbolCurrency && prefix !== symbolCurrency) return null;
  const currency = prefix || symbolCurrency || "UNSPECIFIED";
  return /^\d{1,9}(?:\.\d{2})?$/u.test(compact) ? `${currency}:${compact}` : null;
}

function dateHintMatches(receiptDate, hint) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(receiptDate ?? ""))) return false;
  const requested = String(hint ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/u.test(requested)) return requested === receiptDate;
  const match = /^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(?:(\d{1,2}),\s*)?(\d{4})$/iu.exec(requested);
  if (!match) return false;
  const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(match[1].slice(0, 3).toLowerCase()) + 1;
  const year = Number(match[3]);
  if (!match[2]) return receiptDate.startsWith(`${year}-${String(month).padStart(2, "0")}-`);
  const day = Number(match[2]);
  const expected = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(`${expected}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === expected && receiptDate === expected;
}

function workflowResult(status, ledgerOutcome, reason, vendor, metadata, closeText, evidence = {}) {
  return { status, ledgerOutcome, reason, vendor: vendor ?? null, metadata: metadata ?? null, closeText: closeText ?? null, evidence };
}

function assertDependencies(ledger, services, reporter) {
  if (!ledger || !["claim", "append", "reserveEmail", "finalize"].every((key) => typeof ledger[key] === "function")) {
    throw new Error("a durable receipt ledger is required");
  }
  if (typeof services?.imessage?.replyInThread !== "function") throw new Error("same-thread iMessage reply capability is required");
  for (const key of ["openCase", "heygen", "geniusScan", "alanGmail", "cvsOutlook"]) {
    if (typeof services?.receipts?.[key]?.search !== "function") throw new Error(`${key} receipt search capability is required`);
  }
  if (typeof services?.receipts?.closeSessions !== "function") throw new Error("receipt session close capability is required");
  if (typeof services?.gmail?.getSendAsSignature !== "function" || typeof services?.gmail?.sendReceipt !== "function") {
    throw new Error("Alan Gmail signature and send capabilities are required");
  }
  if (typeof reporter?.record !== "function") throw new Error("durable workflow reporter is required");
}

function safeAppend(ledger, entry) {
  try {
    return ledger.append(entry);
  } catch {
    return null;
  }
}

function safeErrorCode(error) {
  const candidate = typeof error === "string" ? error : error?.code ?? error?.name ?? "unknown";
  return String(candidate).toLowerCase().replace(/[^a-z0-9_-]+/gu, "_").slice(0, 80) || "unknown";
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
