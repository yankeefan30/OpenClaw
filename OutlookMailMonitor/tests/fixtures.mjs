export function testGrant(overrides = {}) {
  return {
    schema: "rico.outlook-mail-monitor-grant",
    schemaVersion: 1,
    mailboxId: "owner@corp.example",
    folderMonitor: {
      folderPath: "Inbox/Leader",
      alertText: "Owner, a monitored-folder message arrived.",
    },
    senderMonitor: {
      folderPath: "Inbox",
      senderAddress: "executive@corp.example",
      alertText: "Owner, a monitored-sender message arrived.",
    },
    imessage: {
      sourceAccount: "owner@personal.example",
      destination: "+12125550123",
    },
    issuedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function message({ id, at, folderPath, senderAddress = "sender@corp.example" }) {
  return {
    immutableId: id,
    receivedAt: at,
    mailboxId: "owner@corp.example",
    folderPath,
    senderAddress,
  };
}
