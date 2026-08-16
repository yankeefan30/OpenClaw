export const JANET_RECEIPT_WORKFLOW = deepFreeze({
  schema: "rico.workflow.single-handler",
  schemaVersion: 2,
  id: "janet-receipt-v2",
  handler: "janet-receipt",
  trigger: {
    surface: "openclaw.plugin.inbound_claim",
    channel: "imessage",
    sender: "permissionGrant.janetHandle",
    aliases: ["rico", "polar"],
    directMessagesOnly: true,
    sameThreadRepliesOnly: true,
    timezone: "America/New_York",
    allowedWindow: { startLocal: "05:30", endLocal: "23:59" },
  },
  routes: [
    { vendor: "OpenCase", locations: ["OpenCase portal"] },
    { vendor: "Heygen", locations: ["Heygen portal"] },
    { vendor: "*", locations: ["Genius Scan", "Alan Gmail", "CVS Outlook"], stopOnFirstExactMatch: true },
  ],
  limits: {
    requestsPerRun: 1,
    acknowledgementAttemptsPerRequest: 1,
    closeReplyAttemptsPerRequest: 1,
    emailAttemptsPerRequest: 1,
    recentLedgerRecords: 100,
  },
  permissions: {
    source: "private-0600-grant",
    required: [
      "imessage.reply.same-thread",
      "opencase.receipt.read",
      "heygen.receipt.read",
      "genius-scan.receipt.read",
      "gmail.alan.receipt.read",
      "outlook.cvs.receipt.read",
      "gmail.alan.send-as-signature.read",
      "gmail.alan.send.exact-recipient",
    ],
    modelMayExpandAuthority: false,
  },
  sequence: [
    "acknowledge-in-source-thread",
    "search-exact-route",
    "verify-pdf-and-extract-vendor-amount-date",
    "fetch-alan-gmail-send-as-signature",
    "reserve-and-send-once-from-alan-gmail",
    "close-browser-sessions",
    "close-source-thread",
    "report-and-audit",
  ],
  failClosed: [
    "login-required",
    "two-factor-required",
    "captcha-required",
    "ambiguous-match",
    "invalid-evidence",
    "signature-unavailable",
    "email-outcome-unknown",
    "integration-unavailable",
  ],
  integration: {
    ingress: "openclaw.plugin.inbound_claim",
    capabilities: ["openclaw.mcp", "saved-browser-session", "private-capability-reference"],
    directCredentialsInWorkflow: false,
  },
});

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
