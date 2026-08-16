import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDirectory, readPrivateJson, writePrivateJson } from "./private-files.mjs";

const EVENT_FIELDS = ["createdAt", "dedupeKey", "pickupEtaMinutes", "rideRef", "rideStatus", "schema", "source", "type", "version"];

export function createReviewedRicoEtaHandoff(event) {
  validateEtaEvent(event);
  const eta = Math.max(0, Math.ceil(event.pickupEtaMinutes));
  const unit = eta === 1 ? "minute" : "minutes";
  return Object.freeze({
    schema: "openclaw.rico.reviewed-imessage-handoff",
    version: 1,
    id: crypto.randomUUID(),
    kind: "uber.driver_arrival_threshold",
    channel: "imessage",
    recipientRoute: Object.freeze({ kind: "reviewed-owner-route", selector: "rico-owner-route" }),
    message: Object.freeze({ text: `Alan, your Uber driver is ${eta} ${unit} away.`, attachments: Object.freeze([]) }),
    source: "uber:riders-api-v1.2",
    sourceRef: event.rideRef,
    sourceDedupeKey: event.dedupeKey,
    observedEtaMinutes: event.pickupEtaMinutes,
    createdAt: event.createdAt,
    requiresReviewedSender: true,
    requiresDeliveryAcknowledgement: true,
    genericSendFallbackAllowed: false,
  });
}

export class EtaHandoffOutbox {
  constructor(directory) {
    if (typeof directory !== "string" || !path.isAbsolute(directory)) throw new Error("ETA outbox path must be absolute.");
    this.directory = directory;
    this.pendingDirectory = path.join(directory, "pending");
    this.acknowledgedDirectory = path.join(directory, "acknowledged");
    ensurePrivateDirectory(this.pendingDirectory);
    ensurePrivateDirectory(this.acknowledgedDirectory);
  }

  enqueue(event) {
    const handoff = createReviewedRicoEtaHandoff(event);
    const key = event.dedupeKey;
    const pendingPath = path.join(this.pendingDirectory, `${key}.json`);
    const acknowledgedPath = path.join(this.acknowledgedDirectory, `${key}.json`);
    if (fs.existsSync(acknowledgedPath)) return Object.freeze({ enqueued: false, acknowledged: true, handoff: readPrivateJson(acknowledgedPath).handoff });
    if (fs.existsSync(pendingPath)) return Object.freeze({ enqueued: false, acknowledged: false, handoff: readPrivateJson(pendingPath).handoff });
    writePrivateJson(pendingPath, {
      schema: "openclaw.rico.reviewed-imessage-outbox-record",
      version: 1,
      state: "pending",
      handoff,
    });
    return Object.freeze({ enqueued: true, acknowledged: false, handoff });
  }

  listPending() {
    return Object.freeze(fs.readdirSync(this.pendingDirectory)
      .filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))
      .sort()
      .map((name) => readPrivateJson(path.join(this.pendingDirectory, name)).handoff));
  }

  acknowledge(receipt) {
    validateReceipt(receipt);
    const pendingPath = path.join(this.pendingDirectory, `${receipt.sourceDedupeKey}.json`);
    if (!fs.existsSync(pendingPath)) throw new Error("No pending reviewed Rico handoff matches this receipt.");
    const record = readPrivateJson(pendingPath);
    if (record.handoff.id !== receipt.handoffId || record.handoff.sourceDedupeKey !== receipt.sourceDedupeKey) {
      throw new Error("The reviewed Rico delivery receipt does not match the pending handoff.");
    }
    const acknowledgedPath = path.join(this.acknowledgedDirectory, `${receipt.sourceDedupeKey}.json`);
    writePrivateJson(acknowledgedPath, { ...record, state: "acknowledged", receipt });
    fs.unlinkSync(pendingPath);
    return Object.freeze({ acknowledged: true, handoff: record.handoff });
  }
}

export function validateEtaEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event) || Object.keys(event).sort().join() !== EVENT_FIELDS.join()) {
    throw new Error("Invalid normalized Uber ETA event fields.");
  }
  if (event.schema !== "openclaw.uber.alert" || event.version !== 1 || event.type !== "driver_arrival_threshold" || event.source !== "uber:riders-api-v1.2") {
    throw new Error("Invalid normalized Uber ETA event contract.");
  }
  if (typeof event.rideRef !== "string" || !/^[a-f0-9-]{36}$/u.test(event.rideRef)) throw new Error("Invalid Uber ride reference.");
  if (!Number.isFinite(event.pickupEtaMinutes) || event.pickupEtaMinutes < 0 || event.pickupEtaMinutes > 3) throw new Error("Uber ETA threshold was not met.");
  if (typeof event.rideStatus !== "string" || event.rideStatus.length < 2 || event.rideStatus.length > 80) throw new Error("Invalid Uber ride status.");
  if (!Number.isFinite(new Date(event.createdAt).getTime())) throw new Error("Invalid Uber ETA event timestamp.");
  if (typeof event.dedupeKey !== "string" || !/^[a-f0-9]{64}$/u.test(event.dedupeKey)) throw new Error("Invalid Uber ETA dedupe key.");
  return true;
}

function validateReceipt(receipt) {
  const fields = ["acknowledgedAt", "deliveryReceiptRef", "handoffId", "routePolicyId", "schema", "sourceDedupeKey", "version"];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || Object.keys(receipt).sort().join() !== fields.join()) throw new Error("Invalid reviewed Rico delivery receipt fields.");
  if (receipt.schema !== "openclaw.rico.reviewed-imessage-delivery-receipt" || receipt.version !== 1) throw new Error("Invalid reviewed Rico delivery receipt contract.");
  if (![receipt.handoffId, receipt.routePolicyId, receipt.deliveryReceiptRef].every((item) => typeof item === "string" && item.length >= 8 && item.length <= 256)) throw new Error("Invalid reviewed Rico delivery receipt identifiers.");
  if (!/^[a-f0-9]{64}$/u.test(receipt.sourceDedupeKey) || !Number.isFinite(new Date(receipt.acknowledgedAt).getTime())) throw new Error("Invalid reviewed Rico delivery receipt proof.");
}

