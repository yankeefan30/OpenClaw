import { API_VERSION } from "./constants.mjs";
import { credentialBundleForStorage, parseCredentialBundle } from "./credentials.mjs";
import { governed } from "./errors.mjs";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class OfficialUberClient {
  constructor({ credentialProvider, fetchFn = globalThis.fetch, now = () => new Date(), timeoutMs = 12_000, rateLimiter } = {}) {
    if (!credentialProvider) throw governed("credential_provider_missing", "An Uber Keychain credential provider is required.");
    if (typeof fetchFn !== "function") throw governed("fetch_missing", "A secure HTTP client is required.");
    if (!rateLimiter || typeof rateLimiter.acquire !== "function") throw governed("rate_limiter_missing", "A persistent Uber rate limiter is required.");
    this.credentialProvider = credentialProvider;
    this.fetchFn = fetchFn;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.rateLimiter = rateLimiter;
  }

  async status() {
    const keychain = await this.credentialProvider.status();
    if (!keychain.available) return Object.freeze({ keychain, enabled: false, reason: keychain.code, environment: null, scopes: [] });
    try {
      return await this.withSession(async (session) => Object.freeze({
        keychain,
        enabled: true,
        environment: session.bundle.environment,
        scopes: [...session.bundle.scopes],
        privilegedRequestApproved: true,
        paymentAliases: ["personal", "business"],
        oauthExpiresAt: session.bundle.expiresAt,
      }));
    } catch (error) {
      return Object.freeze({ keychain, enabled: false, reason: error?.code ?? "credential_bundle_invalid", environment: null, scopes: [] });
    }
  }

  async withSession(operation) {
    return this.credentialProvider.withSecret(async (secret) => {
      const bundle = parseCredentialBundle(secret, this.date());
      const session = new UberSession({ bundle, credentialProvider: this.credentialProvider, fetchFn: this.fetchFn, now: this.now, timeoutMs: this.timeoutMs, rateLimiter: this.rateLimiter });
      return operation(session);
    });
  }

  date() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw governed("clock_invalid", "The Uber client clock is invalid.");
    return date;
  }
}

class UberSession {
  constructor({ bundle, credentialProvider, fetchFn, now, timeoutMs, rateLimiter }) {
    this.bundle = bundle;
    this.credentialProvider = credentialProvider;
    this.fetchFn = fetchFn;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.rateLimiter = rateLimiter;
    this.runtimeAccessToken = null;
  }

  paymentMethod(alias) {
    const identifier = this.bundle.paymentAliases[alias];
    if (!identifier) throw governed("payment_alias_invalid", "The selected Uber payment alias is unavailable.");
    return identifier;
  }

  async products(pickup) {
    return this.api("GET", "/products", {
      query: { latitude: pickup.latitude, longitude: pickup.longitude },
    });
  }

  async estimate(input) {
    return this.api("POST", "/requests/estimate", {
      body: routeBody(input),
      mutation: false,
    });
  }

  async requestRide(input) {
    await this.revalidatePaymentAlias(input.paymentAlias);
    return this.api("POST", "/requests", {
      body: {
        product_id: input.productId,
        fare_id: input.fareId,
        start_latitude: input.pickup.latitude,
        start_longitude: input.pickup.longitude,
        start_nickname: "Pickup",
        start_address: input.pickup.formattedAddress,
        end_latitude: input.dropoff.latitude,
        end_longitude: input.dropoff.longitude,
        end_nickname: "Drop-off",
        end_address: input.dropoff.formattedAddress,
        seat_count: input.seatCount,
        payment_method_id: this.paymentMethod(input.paymentAlias),
        ...(input.expenseCode === null ? {} : { expense_code: input.expenseCode }),
        ...(input.expenseMemo === null ? {} : { expense_memo: input.expenseMemo }),
      },
      mutation: true,
    });
  }

  async requestDetails(requestId, rateKind = "read") {
    return this.api("GET", `/requests/${encodeURIComponent(requestId)}`, { rateKind });
  }

  async cancelRide(requestId) {
    return this.api("DELETE", `/requests/${encodeURIComponent(requestId)}`, { mutation: true, allowEmpty: true });
  }

  async paymentMethods() {
    return this.api("GET", "/payment-methods");
  }

  async revalidatePaymentAlias(selectedAlias) {
    const methods = await this.paymentMethods();
    if (!Array.isArray(methods?.payment_methods) || methods.payment_methods.length > 100) throw governed("payment_methods_invalid", "Uber returned an invalid payment-method list.");
    const available = new Set();
    for (const method of methods.payment_methods) {
      if (!method || typeof method.payment_method_id !== "string" || method.payment_method_id.length < 8 || method.payment_method_id.length > 256) {
        throw governed("payment_methods_invalid", "Uber returned an invalid payment method.");
      }
      available.add(method.payment_method_id);
    }
    const personal = this.bundle.paymentAliases.personal;
    const business = this.bundle.paymentAliases.business;
    if (!available.has(personal) || !available.has(business) || !available.has(this.paymentMethod(selectedAlias))) {
      throw governed("payment_alias_stale", "The reviewed personal/business Uber payment aliases no longer match the rider account. No ride was requested.");
    }
  }

  async token() {
    if (this.runtimeAccessToken) return this.runtimeAccessToken;
    const clock = this.now();
    const date = clock instanceof Date ? clock : new Date(clock);
    if (new Date(this.bundle.expiresAt).getTime() > date.getTime() + 60_000) {
      this.runtimeAccessToken = this.bundle.accessToken;
      return this.runtimeAccessToken;
    }
    const body = new URLSearchParams({
      client_id: this.bundle.clientId,
      client_secret: this.bundle.clientSecret,
      grant_type: "refresh_token",
      refresh_token: this.bundle.refreshToken,
    });
    this.rateLimiter.acquire("oauth");
    let response;
    try {
      response = await timedFetch(this.fetchFn, `${this.bundle.oauthBaseUrl}/oauth/v2/token`, {
        method: "POST",
        redirect: "error",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }, this.timeoutMs);
    } catch {
      throw governed("oauth_refresh_unavailable", "Uber OAuth refresh failed closed.");
    }
    const payload = await readResponse(response, false);
    if (!response.ok || typeof payload.access_token !== "string" || payload.access_token.length < 8 || payload.token_type !== "Bearer") {
      throw governed("oauth_refresh_rejected", "Uber rejected the OAuth refresh.", { details: { status: response.status } });
    }
    const expiresIn = Number(payload.expires_in);
    if (!Number.isFinite(expiresIn) || expiresIn < 60 || expiresIn > 365 * 24 * 60 * 60) throw governed("oauth_refresh_invalid", "Uber returned an invalid OAuth expiry.");
    const scopes = typeof payload.scope === "string" && payload.scope.trim() ? payload.scope.trim().split(/\s+/u) : [...this.bundle.scopes];
    if (payload.refresh_token !== undefined && (typeof payload.refresh_token !== "string" || payload.refresh_token.length < 8 || payload.refresh_token.length > 8192)) {
      throw governed("oauth_refresh_invalid", "Uber returned an invalid rotated refresh token.");
    }
    const next = credentialBundleForStorage(this.bundle, {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? this.bundle.refreshToken,
      expiresAt: new Date(date.getTime() + expiresIn * 1000).toISOString(),
      scopes,
    });
    const serialized = Buffer.from(JSON.stringify(next));
    try {
      parseCredentialBundle(serialized, date);
      await this.credentialProvider.replaceSecret(serialized);
    } finally { serialized.fill(0); }
    this.runtimeAccessToken = payload.access_token;
    return this.runtimeAccessToken;
  }

  async api(method, pathname, { query = undefined, body = undefined, mutation = false, allowEmpty = false, rateKind = undefined } = {}) {
    if (!/^\/(products|payment-methods|requests(?:\/.*)?)$/u.test(pathname)) throw governed("endpoint_not_allowed", "An Uber endpoint is not allowed.");
    const base = `${this.bundle.apiBaseUrl}/${API_VERSION}/`;
    const url = new URL(pathname.replace(/^\//u, ""), base);
    if (url.origin !== this.bundle.apiBaseUrl || !url.pathname.startsWith(`/${API_VERSION}/`)) throw governed("endpoint_escape_blocked", "An Uber endpoint escaped the official v1.2 API surface.");
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
    this.rateLimiter.acquire(rateKind ?? (mutation ? "mutation" : "read"));
    const token = await this.token();
    let response;
    try {
      response = await timedFetch(this.fetchFn, url.href, {
        method,
        redirect: "error",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Accept-Language": "en_US",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }, this.timeoutMs);
    } catch (error) {
      if (mutation) {
        throw governed("uber_mutation_outcome_unknown", "Uber did not return a definitive result. This mutation is quarantined and will not be retried automatically.");
      }
      const timedOut = error instanceof Error && error.name === "AbortError";
      throw governed(timedOut ? "uber_timeout" : "uber_network_error", "The official Uber API could not be reached.", { retryable: true });
    }
    const payload = await readResponse(response, allowEmpty);
    if (!response.ok) {
      if (mutation && (response.status === 408 || response.status === 429 || response.status >= 500)) {
        throw governed("uber_mutation_outcome_unknown", "Uber returned an indeterminate mutation response. This action is quarantined and will not be retried automatically.");
      }
      throw governed("uber_api_rejected", "The official Uber API rejected the request.", {
        retryable: !mutation && (response.status === 429 || response.status >= 500),
        details: { status: response.status, apiCode: safeApiCode(payload) },
      });
    }
    return payload;
  }
}

function routeBody(input) {
  return {
    product_id: input.productId,
    start_latitude: input.pickup.latitude,
    start_longitude: input.pickup.longitude,
    end_latitude: input.dropoff.latitude,
    end_longitude: input.dropoff.longitude,
    seat_count: input.seatCount,
  };
}

async function timedFetch(fetchFn, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try { return await fetchFn(url, { ...options, signal: controller.signal }); } finally { clearTimeout(timer); }
}

async function readResponse(response, allowEmpty) {
  const length = Number(response.headers?.get?.("content-length") ?? 0);
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw governed("response_too_large", "The Uber API response exceeded the governed size limit.");
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw governed("response_too_large", "The Uber API response exceeded the governed size limit.");
  if (!text.trim()) {
    if (allowEmpty) return {};
    throw governed("response_empty", "The Uber API returned an unexpected empty response.");
  }
  try { return JSON.parse(text); } catch { throw governed("response_invalid", "The Uber API returned invalid JSON."); }
}

function safeApiCode(payload) {
  const value = payload?.code ?? payload?.meta?.code ?? null;
  return typeof value === "string" ? value.slice(0, 80) : null;
}
