import { governed } from "./errors.mjs";

/** Default production posture until a separately reviewed geocoder is wired. */
export class DisabledGeocoderAdapter {
  async status() {
    return Object.freeze({ ready: false, approved: false, serverSide: true, provider: null, reason: "approved_geocoder_missing" });
  }

  async search() {
    throw governed("approved_geocoder_missing", "No approved server-side geocoder is configured for Uber pickup and drop-off resolution.");
  }

  async resolve() {
    throw governed("approved_geocoder_missing", "No approved server-side geocoder is configured for Uber pickup and drop-off resolution.");
  }
}

export async function requireApprovedGeocoder(adapter) {
  if (!adapter || typeof adapter.status !== "function" || typeof adapter.search !== "function" || typeof adapter.resolve !== "function") {
    throw governed("approved_geocoder_missing", "No approved server-side geocoder is configured.");
  }
  const status = await adapter.status();
  if (!status || status.ready !== true || status.approved !== true || status.serverSide !== true
    || typeof status.provider !== "string" || status.provider.length < 2 || status.provider.length > 80
    || typeof status.approvalReference !== "string" || status.approvalReference.length < 6 || status.approvalReference.length > 128) {
    throw governed("approved_geocoder_missing", "The server-side geocoder is unavailable or lacks a current approval record.");
  }
  return Object.freeze({ provider: status.provider, approvalReference: status.approvalReference });
}

export function validateAddressQuery(value) {
  if (typeof value !== "string") throw governed("address_query_invalid", "A human-readable street address is required.");
  const query = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (query.length < 5 || query.length > 300 || /[\u0000-\u001f\u007f]/u.test(query)) throw governed("address_query_invalid", "A complete human-readable street address is required.");
  if (!/[0-9]/u.test(query) || !/[A-Za-z]/u.test(query)) throw governed("address_query_incomplete", "The address must include a street number and street name.");
  return query;
}

export function validateSearchCandidates(value, provider) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10) throw governed("geocoder_candidates_invalid", "The approved geocoder returned an invalid candidate set.");
  return Object.freeze(value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw governed("geocoder_candidate_invalid", "The approved geocoder returned an invalid candidate.");
    const keys = Object.keys(candidate).sort().join();
    if (keys !== ["adapterRef", "formattedAddress", "provider"].sort().join() || candidate.provider !== provider) throw governed("geocoder_candidate_invalid", "The geocoder candidate contract is invalid.");
    return Object.freeze({
      provider,
      adapterRef: bounded(candidate.adapterRef, 3, 512, "geocoder_adapter_ref_invalid"),
      formattedAddress: bounded(candidate.formattedAddress, 5, 300, "geocoder_address_invalid"),
    });
  }));
}

export function validateResolvedLocation(value, provider) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== [
    "adapterRef", "formattedAddress", "latitude", "longitude", "precision", "provider", "resolvedAt",
  ].sort().join() || value.provider !== provider) {
    throw governed("geocoder_resolution_invalid", "The approved geocoder resolution contract is invalid.");
  }
  const latitude = coordinate(value.latitude, -90, 90, "geocoder_latitude_invalid");
  const longitude = coordinate(value.longitude, -180, 180, "geocoder_longitude_invalid");
  const precision = bounded(value.precision, 2, 40, "geocoder_precision_invalid");
  if (!new Set(["rooftop", "parcel", "entrance", "address"]).has(precision)) throw governed("geocoder_precision_invalid", "The location is not resolved to an exact address.");
  const resolvedAt = new Date(value.resolvedAt);
  const now = new Date();
  if (!Number.isFinite(resolvedAt.getTime()) || resolvedAt > now || now.getTime() - resolvedAt.getTime() > 10 * 60_000) throw governed("geocoder_resolution_stale", "The approved geocoder resolution is stale.");
  return Object.freeze({
    provider,
    adapterRef: bounded(value.adapterRef, 3, 512, "geocoder_adapter_ref_invalid"),
    formattedAddress: bounded(value.formattedAddress, 5, 300, "geocoder_address_invalid"),
    latitude,
    longitude,
    precision,
    resolvedAt: resolvedAt.toISOString(),
  });
}

function bounded(value, min, max, code) {
  if (typeof value !== "string" || value.length < min || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw governed(code, "The approved geocoder returned invalid text.");
  return value;
}

function coordinate(value, min, max, code) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw governed(code, "The approved geocoder returned invalid coordinates.");
  return value;
}
