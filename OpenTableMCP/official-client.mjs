import { governed } from "./errors.mjs";
import { parseCredentialBundle } from "./credentials.mjs";
import { BoundedRateLimiter } from "./rate-limiter.mjs";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class OfficialOpenTableClient {
  constructor({ credentialProvider, fetchFn = globalThis.fetch, now = () => new Date(), timeoutMs = 12_000, rateLimiter = undefined } = {}) {
    if (!credentialProvider) throw governed("credential_provider_missing", "An OpenTable Keychain provider is required.");
    if (typeof fetchFn !== "function") throw governed("fetch_missing", "A secure HTTP client is required.");
    this.credentialProvider = credentialProvider;
    this.fetchFn = fetchFn;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.rateLimiter = rateLimiter ?? new BoundedRateLimiter({ now });
  }

  async status() {
    const keychain = await this.credentialProvider.status();
    if (!keychain.available) return { keychain, enabled: false, reason: keychain.code, capabilities: [] };
    try {
      return await this.withSession(async (session) => ({
        keychain,
        enabled: true,
        environment: session.bundle.environment,
        apiFamily: session.bundle.apiFamily,
        approvalExpiresAt: session.bundle.approval.expiresAt,
        capabilities: [...session.bundle.approval.approvedCapabilities],
        dinerProfileReady: true,
      }));
    } catch (error) {
      return { keychain, enabled: false, reason: error?.code ?? "credential_bundle_invalid", capabilities: [] };
    }
  }

  async withSession(operation) {
    return this.credentialProvider.withSecret(async (secret) => {
      const bundle = parseCredentialBundle(secret, this.now());
      const session = new OpenTableSession({ bundle, fetchFn: this.fetchFn, timeoutMs: this.timeoutMs, rateLimiter: this.rateLimiter });
      return operation(session);
    });
  }
}

class OpenTableSession {
  constructor({ bundle, fetchFn, timeoutMs, rateLimiter }) {
    this.bundle = bundle;
    this.fetchFn = fetchFn;
    this.timeoutMs = timeoutMs;
    this.rateLimiter = rateLimiter;
    this.accessToken = null;
  }

  requireCapability(capability) {
    if (!this.bundle.approval.approvedCapabilities.includes(capability)) {
      throw governed("capability_not_approved", `The OpenTable partner contract does not approve ${capability}.`);
    }
  }

  async directory({ rid, country, offset, limit }) {
    this.requireCapability("directory");
    const query = { offset, limit };
    if (rid !== undefined) query.rid = rid;
    if (country) query.country = country;
    return this.request("GET", "/sync/directory", { query });
  }

  async availability(input) {
    this.requireCapability("availability");
    return this.request("GET", `/v2/availability/${input.rid}`, {
      query: {
        start_date_time: input.startDateTime,
        forward_minutes: input.forwardMinutes,
        backward_minutes: input.backwardMinutes,
        party_size: input.partySize,
        require_attributes: input.reservationAttribute,
        include_credit_card_results: false,
        include_experiences: false,
      },
    });
  }

  async bookingPolicies({ rid, date, time, partySize }) {
    this.requireCapability("booking_policy");
    return this.request("GET", `/v2/booking-policies/${rid}/${encodeURIComponent(date)}/${encodeURIComponent(time)}/${partySize}`, { query: { dinerContext: "details" } });
  }

  async cancellationPolicy({ rid, policyId }) {
    this.requireCapability("cancellation_policy");
    return this.request("GET", `/v2/cancellation-policies/${rid}/${encodeURIComponent(policyId)}`);
  }

  async createSlotLock(input, requestId) {
    this.requireCapability("slot_lock");
    return this.request("POST", `/v2/booking/${input.rid}/slot_locks`, {
      requestId,
      body: {
        party_size: input.partySize,
        date_time: input.dateTime,
        reservation_attribute: input.reservationAttribute,
        ...(input.diningAreaId === null ? {} : { dining_area_id: input.diningAreaId }),
        ...(input.environment === null ? {} : { environment: input.environment }),
      },
    });
  }

  async releaseSlotLock({ rid, reservationToken }, requestId) {
    this.requireCapability("slot_lock");
    return this.request("DELETE", `/v2/booking/${rid}/slot_locks/${encodeURIComponent(reservationToken)}`, { requestId, allowEmpty: true });
  }

  async makeReservation(input, requestId) {
    this.requireCapability("book");
    const diner = this.bundle.diner;
    return this.request("POST", `/v2/booking/${input.rid}/reservations`, {
      requestId,
      body: {
        reservation_token: input.reservationToken,
        first_name: diner.firstName,
        last_name: diner.lastName,
        email_address: diner.email,
        phone: {
          number: diner.phone.number,
          country_code: diner.phone.countryCode,
          phone_type: diner.phone.type,
        },
        reservation_attribute: input.reservationAttribute,
        special_request: input.specialRequest,
      },
    });
  }

  async getReservation({ rid, confirmationNumber }) {
    this.requireCapability("get_reservation");
    return this.request("GET", `/v2/booking/${rid}/reservations/${rid}-${encodeURIComponent(confirmationNumber)}`);
  }

  async cancelReservation({ rid, confirmationNumber }, requestId) {
    this.requireCapability("cancel");
    return this.request("PUT", `/v2/booking/${rid}/reservations/${rid}-${encodeURIComponent(confirmationNumber)}`, {
      requestId,
      body: { status: "CancelledWeb" },
      allowEmpty: true,
    });
  }

  async token() {
    if (this.accessToken) return this.accessToken;
    const basic = Buffer.from(`${this.bundle.clientId}:${this.bundle.clientSecret}`, "utf8").toString("base64");
    this.rateLimiter.acquire("read");
    const response = await timedFetch(this.fetchFn, `${this.bundle.oauthBaseUrl}/api/v2/oauth/token?grant_type=client_credentials`, {
      method: "GET",
      redirect: "error",
      headers: {
        Authorization: `Basic ${basic}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Content-Length": "0",
      },
    }, this.timeoutMs);
    const payload = await readResponse(response, false);
    if (!response.ok || !payload || typeof payload.access_token !== "string" || payload.access_token.length < 16) {
      throw apiError(response, "oauth_failed", "OpenTable OAuth authorization failed.");
    }
    this.accessToken = payload.access_token;
    return this.accessToken;
  }

  async request(method, pathname, { query = undefined, body = undefined, requestId = undefined, allowEmpty = false } = {}) {
    const token = await this.token();
    const url = new URL(pathname, `${this.bundle.apiBaseUrl}/`);
    if (url.origin !== this.bundle.apiBaseUrl) throw governed("endpoint_escape_blocked", "An OpenTable endpoint escaped the reviewed API origin.");
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json;charset=UTF-8",
      "Accept-Language": "en-US",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json;charset=UTF-8";
    if (requestId !== undefined) headers["X-Request-Id"] = requestId;
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && !requestId) throw governed("request_id_missing", "A stable X-Request-Id is required for OpenTable mutations.");
    this.rateLimiter.acquire(["POST", "PUT", "PATCH", "DELETE"].includes(method) ? "mutation" : "read");
    let response;
    try {
      response = await timedFetch(this.fetchFn, url.href, {
        method,
        redirect: "error",
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }, this.timeoutMs);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw governed("opentable_timeout", "OpenTable did not answer before the governed timeout.", { retryable: method === "GET" });
      throw governed("opentable_network_error", "The official OpenTable API could not be reached.", { retryable: method === "GET" });
    }
    const payload = await readResponse(response, allowEmpty);
    if (!response.ok) throw apiError(response, "opentable_api_error", "The official OpenTable API rejected the request.");
    return payload;
  }
}

async function timedFetch(fetchFn, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try { return await fetchFn(url, { ...options, signal: controller.signal }); } finally { clearTimeout(timer); }
}

async function readResponse(response, allowEmpty) {
  const length = Number(response.headers?.get?.("content-length") ?? 0);
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw governed("response_too_large", "The OpenTable API response exceeded the governed size limit.");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw governed("response_too_large", "The OpenTable API response exceeded the governed size limit.");
  if (!text.trim()) {
    if (allowEmpty) return {};
    throw governed("response_empty", "The OpenTable API returned an unexpected empty response.");
  }
  try { return JSON.parse(text); } catch { throw governed("response_invalid", "The OpenTable API returned invalid JSON."); }
}

function apiError(response, code, message) {
  const requestId = response.headers?.get?.("ot-requestid") ?? response.headers?.get?.("ot-request-id") ?? null;
  return governed(code, message, {
    retryable: response.status === 429 || response.status >= 500,
    details: { status: response.status, ...(requestId ? { requestId: requestId.slice(0, 128) } : {}) },
  });
}
