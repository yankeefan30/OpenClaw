import crypto from "node:crypto";
import { REQUIRED_GATEWAY_CONTRACT } from "./config.mjs";
import { codedError } from "./errors.mjs";

/**
 * Adapter for the attachment-specific reviewed Rico seam. This intentionally
 * refuses the generic Gateway `send` method: the reviewed contract must bind
 * recipient, clip hash, file metadata, confirmation, and idempotency key.
 */
export class ReviewedRicoAttachmentAdapter {
  constructor({ gateway, method = "rico.imessage.sendReviewedAttachment" }) {
    this.gateway = gateway;
    this.method = method;
  }

  async health() {
    if (!this.gateway || typeof this.gateway.call !== "function" || this.method !== "rico.imessage.sendReviewedAttachment") {
      return { ready: false, code: "reviewed_delivery_unavailable" };
    }
    try {
      const result = await this.gateway.call("rico.imessage.attachmentStatus", {});
      const ready = result?.healthy === true && result?.enforcement?.verified === true &&
        result?.contractVersion === REQUIRED_GATEWAY_CONTRACT;
      return { ready, code: ready ? "ok" : "reviewed_delivery_contract_unverified" };
    } catch {
      return { ready: false, code: "reviewed_delivery_unavailable" };
    }
  }

  async send({ clip, recipient, caption = "", confirmation, idempotencyKey, recipientAuthority }) {
    if (!confirmation?.id || confirmation?.purpose !== "scheduled_fire" && confirmation?.purpose !== "initial_send") {
      throw codedError("confirmation_required", "Explicit human confirmation is required.");
    }
    const key = String(idempotencyKey ?? "");
    if (!key || key.length > 160) throw codedError("idempotency_key_required", "A one-time delivery key is required.");
    if (!recipientAuthority || recipientAuthority.recipient !== recipient || !recipientAuthority.policyVersion || !recipientAuthority.revision) {
      throw codedError("recipient_authority_required", "Rico's live recipient authorization is required.");
    }
    const payload = Object.freeze({
      channel: "imessage",
      recipient,
      text: String(caption ?? ""),
      attachments: [Object.freeze({
        path: clip.path,
        mime: clip.mime,
        sha256: clip.sha256,
        byte_size: clip.byte_size,
      })],
      direction: "outbound",
      source_ref: clip.id,
      source: "grok:bad-rudy",
      confirmation_id: confirmation.id,
      confirmation_purpose: confirmation.purpose,
      idempotencyKey: key,
      contractVersion: REQUIRED_GATEWAY_CONTRACT,
      recipient_authority: Object.freeze({
        recipient: recipientAuthority.recipient,
        policyVersion: recipientAuthority.policyVersion,
        revision: recipientAuthority.revision,
        stage: recipientAuthority.stage,
      }),
    });
    const result = await this.gateway.call(this.method, payload);
    if (result?.contractVersion !== REQUIRED_GATEWAY_CONTRACT || result?.confirmed !== true ||
        typeof result?.messageId !== "string" || !result.messageId.trim()) {
      throw codedError("delivery_outcome_unknown", "Rico did not return a confirmed attachment delivery receipt.");
    }
    return Object.freeze({
      status: "sent",
      messageId: result.messageId,
      deduplicated: result.deduplicated === true,
      contractVersion: result.contractVersion,
    });
  }
}

export function deliveryIdempotencyKey(clipId, recipient, purpose) {
  return `bad-rudy-${crypto.createHash("sha256").update(`${clipId}\u0000${recipient}\u0000${purpose}`, "utf8").digest("hex")}`;
}
