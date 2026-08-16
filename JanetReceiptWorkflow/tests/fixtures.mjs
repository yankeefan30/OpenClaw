import { validatePermissionGrant } from "../policy.mjs";

export const grant = validatePermissionGrant({
  schemaVersion: 2,
  janetHandle: "+1 (555) 010-0200",
  janetEmailRecipient: "Janet.Locked@Example.test",
  alanGmailSender: "Alan.SendAs@Example.test",
  openCaseOrigin: "https://opencase.example.test/receipts",
  heygenOrigin: "https://heygen.example.test/billing",
  capabilityRefs: {
    openCaseSession: "browser-session:opencase",
    heygenSession: "browser-session:heygen",
    geniusScan: "private-ref:genius-scan",
    alanGmail: "mcp:gmail-alan",
    cvsOutlook: "mcp:outlook-cvs",
  },
});

export function inbound(overrides = {}) {
  return {
    channel: "imessage",
    senderHandle: "+15550100200",
    content: "@rico find the OpenCase receipt for $42.17 on 2026-07-08",
    chatGuid: "iMessage;-;+15550100200",
    messageTs: "2026-08-15T11:59:59-04:00",
    isGroup: false,
    direction: "in",
    ...overrides,
  };
}
