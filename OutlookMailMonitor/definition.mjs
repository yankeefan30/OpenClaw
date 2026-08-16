export const POLL_INTERVAL_MS = 90_000;
export const FOLDER_MONITOR_ID = "folder-monitor";
export const SENDER_MONITOR_ID = "sender-monitor";

export const OUTLOOK_MAIL_MONITOR = deepFreeze({
  schema: "rico.workflow.mail-monitor",
  schemaVersion: 1,
  id: "rico-outlook-mail-monitor-v1",
  enabledByDefault: false,
  schedule: { kind: "interval", everyMilliseconds: POLL_INTERVAL_MS },
  inputs: {
    contentAccess: "metadata-only",
    fields: ["immutableId", "receivedAt", "senderAddress"],
    streams: [FOLDER_MONITOR_ID, SENDER_MONITOR_ID],
  },
  permissions: {
    source: "private-0600-grant",
    required: [
      "outlook.metadata.read.exact-mailbox-folder",
      "outlook.metadata.read.exact-mailbox-sender",
      "imessage.send.exact-source-destination",
    ],
    modelMayExpandAuthority: false,
  },
  delivery: {
    baselineExistingMessages: true,
    durableImmutableIdDedupe: true,
    unknownOutcomeMayRetry: false,
    emptyRunsAreSilent: true,
  },
});

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
