import crypto from "node:crypto";
import path from "node:path";
import { randomId, sha256 } from "./canonical.mjs";
import { governed } from "./errors.mjs";
import { ensurePrivateDirectory, readPrivateJson, safeRecordPath, writePrivateJson } from "./private-store.mjs";

const REF = /^(candidate|location)_([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/u;

export class PrivateLocationStore {
  constructor({ directory, ledger, now = () => new Date() } = {}) {
    this.directory = ensurePrivateDirectory(path.join(directory, "locations"));
    this.ledger = ledger;
    this.now = now;
    ensurePrivateDirectory(path.join(this.directory, "candidates"));
    ensurePrivateDirectory(path.join(this.directory, "resolved"));
  }

  createCandidates({ query, provider, approvalReference, candidates, hmacKey }) {
    return Object.freeze(candidates.map((candidate) => {
      const id = randomId();
      const now = this.date();
      const record = {
        schema: "openclaw.uber.location-candidate",
        version: 1,
        id,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
        queryDigest: sha256(query),
        provider,
        approvalReference,
        adapterRef: candidate.adapterRef,
        formattedAddress: candidate.formattedAddress,
      };
      writePrivateJson(this.path("candidates", id), record, { exclusive: true });
      const candidateRef = signRef("candidate", id, sha256(record), hmacKey);
      this.ledger.append("location.candidate.created", { candidateDigest: sha256(candidateRef), queryDigest: record.queryDigest, provider });
      return Object.freeze({ candidateRef, formattedAddress: record.formattedAddress, provider });
    }));
  }

  readCandidate(reference, hmacKey) {
    const { id } = parseRef(reference, "candidate");
    const record = readPrivateJson(this.path("candidates", id));
    verifyRecordRef(reference, "candidate", record, hmacKey);
    if (record.schema !== "openclaw.uber.location-candidate" || record.version !== 1 || new Date(record.expiresAt) <= this.date()) {
      throw governed("location_candidate_expired", "The private Uber location candidate is invalid or expired.");
    }
    return Object.freeze(record);
  }

  createResolved({ candidate, resolved, hmacKey }) {
    if (candidate.provider !== resolved.provider || candidate.adapterRef !== resolved.adapterRef) throw governed("geocoder_candidate_mismatch", "The geocoder resolved a different candidate.");
    const id = randomId();
    const now = this.date();
    const record = {
      schema: "openclaw.uber.resolved-location",
      version: 1,
      id,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
      provider: resolved.provider,
      approvalReference: candidate.approvalReference,
      candidateDigest: sha256(candidate.id),
      formattedAddress: resolved.formattedAddress,
      latitude: resolved.latitude,
      longitude: resolved.longitude,
      precision: resolved.precision,
      resolvedAt: resolved.resolvedAt,
    };
    writePrivateJson(this.path("resolved", id), record, { exclusive: true });
    const locationRef = signRef("location", id, sha256(record), hmacKey);
    this.ledger.append("location.resolved", { locationDigest: sha256(locationRef), candidateDigest: record.candidateDigest, provider: record.provider, precision: record.precision });
    return Object.freeze({ locationRef, formattedAddress: record.formattedAddress, provider: record.provider, precision: record.precision, expiresAt: record.expiresAt });
  }

  readResolved(reference, hmacKey) {
    const { id } = parseRef(reference, "location");
    const record = readPrivateJson(this.path("resolved", id));
    verifyRecordRef(reference, "location", record, hmacKey);
    if (record.schema !== "openclaw.uber.resolved-location" || record.version !== 1 || new Date(record.expiresAt) <= this.date()) {
      throw governed("location_ref_expired", "The private signed Uber location reference is invalid or expired.");
    }
    return Object.freeze(record);
  }

  path(kind, id) { return safeRecordPath(path.join(this.directory, kind), id); }

  date() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw governed("clock_invalid", "The Uber location-store clock is invalid.");
    return date;
  }
}

function signRef(kind, id, recordDigest, hmacKeyBase64) {
  const signature = crypto.createHmac("sha256", Buffer.from(hmacKeyBase64, "base64")).update(`${kind}:${id}:${recordDigest}`).digest("base64url");
  return `${kind}_${id}.${signature}`;
}

function parseRef(reference, expectedKind) {
  const match = REF.exec(String(reference ?? ""));
  if (!match || match[1] !== expectedKind) throw governed("location_ref_invalid", "The private signed Uber location reference is invalid.");
  return { kind: match[1], id: match[2], signature: match[3] };
}

function verifyRecordRef(reference, kind, record, hmacKey) {
  const expected = signRef(kind, record.id, sha256(record), hmacKey);
  const supplied = Buffer.from(reference);
  const expectedBytes = Buffer.from(expected);
  const matches = supplied.length === expectedBytes.length && crypto.timingSafeEqual(supplied, expectedBytes);
  supplied.fill(0); expectedBytes.fill(0);
  if (!matches) throw governed("location_ref_invalid", "The private signed Uber location reference failed integrity verification.");
}
