import { createHash } from "node:crypto";
import { FOLDER_MONITOR_ID, SENDER_MONITOR_ID } from "./definition.mjs";
import { streamFor } from "./state-store.mjs";
import { validatePermissionGrant } from "./grant.mjs";

const METADATA_FIELDS = Object.freeze(["immutableId", "receivedAt", "senderAddress"]);

export class OutlookMailMonitorEngine {
  constructor({ permissionGrant, adapter, store, now = () => new Date() }) {
    this.grant = validatePermissionGrant(permissionGrant);
    this.adapter = validateAdapter(adapter);
    this.store = store;
    this.now = now;
  }

  async runOnce() {
    await this.verifyPreflight();
    const outcomes = [];
    for (const monitor of monitorDefinitions(this.grant)) outcomes.push(await this.runMonitor(monitor));
    return Object.freeze({
      status: "ok",
      streams: outcomes,
      alertsConfirmed: outcomes.reduce((sum, item) => sum + item.alertsConfirmed, 0),
      deliveryUnknown: outcomes.reduce((sum, item) => sum + item.deliveryUnknown, 0),
    });
  }

  async verifyPreflight() {
    const proof = await this.adapter.preflight({
      mailboxId: this.grant.mailboxId,
      sourceAccount: this.grant.imessage.sourceAccount,
      destination: this.grant.imessage.destination,
      requiredCapabilities: [
        "outlook.metadata.immutable-id",
        "outlook.delta.created-only",
        "imessage.source-identity-proof",
        "imessage.no-sms-fallback",
        "imessage.idempotent-send",
      ],
    });
    exactKeys(proof, [
      "ok",
      "mailboxId",
      "metadataOnly",
      "immutableIds",
      "createdOnly",
      "sourceAccount",
      "destination",
      "imessageOnly",
      "idempotentSends",
    ], "preflight proof");
    if (proof.ok !== true
      || proof.metadataOnly !== true
      || proof.immutableIds !== true
      || proof.createdOnly !== true
      || proof.imessageOnly !== true
      || proof.idempotentSends !== true) throw coded("preflight_capability_unproven");
    if (normalizeEmail(proof.mailboxId) !== this.grant.mailboxId) throw coded("preflight_mailbox_mismatch");
    if (normalizeEmail(proof.sourceAccount) !== this.grant.imessage.sourceAccount) throw coded("preflight_source_mismatch");
    if (String(proof.destination ?? "").trim() !== this.grant.imessage.destination) throw coded("preflight_destination_mismatch");
  }

  async runMonitor(monitor) {
    const monitorStartedAt = this.now().toISOString();
    let state = this.store.load();
    let stream = streamFor(state, monitor.id);
    const baselineOnly = stream.initializedAt === null;
    const poll = await this.adapter.pollMetadata({
      monitorId: monitor.id,
      mailboxId: this.grant.mailboxId,
      folderPath: monitor.folderPath,
      senderAddress: monitor.senderAddress,
      cursor: stream.cursor,
      baselineOnly,
      fields: [...METADATA_FIELDS],
      immutableIds: true,
      createdOnly: true,
      maxItems: 10_000,
    });
    const batch = validatePoll(poll, monitor, this.grant.mailboxId);
    const tickAt = monitorStartedAt;

    if (baselineOnly) {
      stream.initializedAt = tickAt;
      stream.cursor = batch.nextCursor;
      for (const item of uniqueItems(batch.items)) {
        const identityHash = hashIdentity(this.grant.mailboxId, item.immutableId);
        if (!findRecordAcrossStreams(state, identityHash)) stream.records.push({ identityHash, status: "baseline", at: tickAt });
      }
      trimRecords(stream);
      this.store.save(state);
      return Object.freeze({ id: monitor.id, baseline: true, inspected: batch.items.length, alertsConfirmed: 0, deliveryUnknown: 0 });
    }

    let alertsConfirmed = 0;
    let deliveryUnknown = 0;
    for (const item of uniqueItems(batch.items)) {
      state = this.store.load();
      stream = streamFor(state, monitor.id);
      const identityHash = hashIdentity(this.grant.mailboxId, item.immutableId);
      if (findRecordAcrossStreams(state, identityHash)) continue;
      if (Date.parse(item.receivedAt) <= Date.parse(stream.initializedAt)) {
        state = this.store.record(state, monitor.id, { identityHash, status: "late-baseline", at: this.now().toISOString() });
        continue;
      }

      const reservedAt = this.now().toISOString();
      state = this.store.record(state, monitor.id, { identityHash, status: "reserved", at: reservedAt });
      try {
        const sent = await this.adapter.sendIMessage({
          sourceAccount: this.grant.imessage.sourceAccount,
          destination: this.grant.imessage.destination,
          text: monitor.alertText,
          idempotencyKey: `rico-mail-monitor:${identityHash}`,
          requireSourceIdentityProof: true,
          service: "imessage",
          allowSmsFallback: false,
        });
        validateSendProof(sent, this.grant);
        state = this.store.load();
        this.store.record(state, monitor.id, { identityHash, status: "sent", at: this.now().toISOString() });
        alertsConfirmed += 1;
      } catch (error) {
        state = this.store.load();
        this.store.record(state, monitor.id, { identityHash, status: "outcome-unknown", at: this.now().toISOString() });
        deliveryUnknown += 1;
        // No retry: a transport exception or incomplete proof can mean that
        // delivery occurred. Replaying could duplicate the user's alert.
      }
    }

    state = this.store.load();
    stream = streamFor(state, monitor.id);
    stream.cursor = batch.nextCursor;
    this.store.save(state);
    return Object.freeze({ id: monitor.id, baseline: false, inspected: batch.items.length, alertsConfirmed, deliveryUnknown });
  }
}

export function monitorDefinitions(grant) {
  return [
    {
      id: FOLDER_MONITOR_ID,
      folderPath: grant.folderMonitor.folderPath,
      senderAddress: null,
      alertText: grant.folderMonitor.alertText,
    },
    {
      id: SENDER_MONITOR_ID,
      folderPath: grant.senderMonitor.folderPath,
      senderAddress: grant.senderMonitor.senderAddress,
      alertText: grant.senderMonitor.alertText,
    },
  ];
}

function validateAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") throw coded("adapter_missing");
  for (const method of ["preflight", "pollMetadata", "sendIMessage"]) {
    if (typeof adapter[method] !== "function") throw coded(`adapter_${method}_missing`);
  }
  return adapter;
}

function validatePoll(value, monitor, mailboxId) {
  exactKeys(value, ["items", "nextCursor"], "metadata poll");
  if (!Array.isArray(value.items) || value.items.length > 10_000) throw coded("poll_items_invalid");
  if (typeof value.nextCursor !== "string" || !value.nextCursor || value.nextCursor.length > 16_384) throw coded("poll_cursor_invalid");
  const items = value.items.map((item) => validateItem(item, monitor, mailboxId));
  return { items, nextCursor: value.nextCursor };
}

function validateItem(item, monitor, mailboxId) {
  exactKeys(item, ["immutableId", "receivedAt", "mailboxId", "folderPath", "senderAddress"], "mail metadata item");
  const immutableId = String(item.immutableId ?? "").trim();
  if (!immutableId || immutableId.length > 4_096) throw coded("message_identity_invalid");
  const receivedAt = new Date(String(item.receivedAt ?? ""));
  if (!Number.isFinite(receivedAt.getTime())) throw coded("message_received_at_invalid");
  if (normalizeEmail(item.mailboxId) !== mailboxId) throw coded("message_mailbox_mismatch");
  if (String(item.folderPath ?? "").trim() !== monitor.folderPath) throw coded("message_folder_mismatch");
  const senderAddress = normalizeEmail(item.senderAddress);
  if (!senderAddress) throw coded("message_sender_invalid");
  if (monitor.senderAddress && senderAddress !== monitor.senderAddress) throw coded("message_sender_mismatch");
  return { immutableId, receivedAt: receivedAt.toISOString(), senderAddress };
}

function validateSendProof(value, grant) {
  exactKeys(value, [
    "ok",
    "sourceAccount",
    "destination",
    "transportMessageId",
    "sourceIdentityProven",
    "service",
    "smsFallbackDisabled",
  ], "send proof");
  if (value.ok !== true
    || value.sourceIdentityProven !== true
    || value.service !== "imessage"
    || value.smsFallbackDisabled !== true) throw coded("send_unconfirmed");
  if (normalizeEmail(value.sourceAccount) !== grant.imessage.sourceAccount) throw coded("send_source_mismatch");
  if (String(value.destination ?? "").trim() !== grant.imessage.destination) throw coded("send_destination_mismatch");
  if (!String(value.transportMessageId ?? "").trim()) throw coded("send_transport_identity_missing");
}

function uniqueItems(items) {
  const found = new Map();
  for (const item of items) if (!found.has(item.immutableId)) found.set(item.immutableId, item);
  return [...found.values()];
}

function findRecordAcrossStreams(state, identityHash) {
  return Object.values(state.streams).some((stream) =>
    stream.records.some((record) => record.identityHash === identityHash));
}

function trimRecords(stream) {
  if (stream.records.length > 2_000) stream.records.splice(0, stream.records.length - 2_000);
}

function hashIdentity(mailboxId, immutableId) {
  return createHash("sha256").update(`${mailboxId}\0${immutableId}`, "utf8").digest("hex");
}

function normalizeEmail(input) {
  const value = String(input ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value) ? value : "";
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw coded(`${label.replaceAll(" ", "_")}_invalid`);
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) throw coded(`${label.replaceAll(" ", "_")}_fields_invalid`);
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
