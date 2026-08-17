import { personAuthorization } from "../../RicoEmailGovernance/tests/fixtures.mjs";
import { validateAllowlist } from "../allowlist.mjs";
import { createBridgeHttpServer } from "../http-server.mjs";

export const TOKEN = "test-lindy-bridge-token";

export function exampleAllowlist(overrides = {}) {
  return validateAllowlist({
    schema: "rico.lindy-local-bridge-allowlist",
    schemaVersion: 1,
    people: [
      { name: "Alan Rosa", role: "owner" },
      { name: "Janet Cummings", role: "approved" },
    ],
    workflows: [
      { id: "lindy-cvs-mail-read", tools: ["health", "outlook_list_inbox", "outlook_search", "outlook_get"] },
      { id: "lindy-cvs-mail-draft", tools: ["outlook_draft"] },
      { id: "lindy-cvs-calendar", tools: ["health", "calendar_list", "calendar_upsert"] },
    ],
    ...overrides,
  });
}

export function ownerPolicy() {
  return {
    schemaVersion: 2,
    paused: false,
    identities: [{
      target: "owner-direct",
      kind: "individual",
      access: "owner",
      requireMention: false,
      autoReply: true,
      quietStart: 0,
      quietEnd: 0,
    }],
  };
}

export function mockLocalApps({
  drafts = [],
  sends = [],
  listed = [{ id: "11", subject: "Flight note", from: "janet@example.com", date: "2026-08-17T12:00:00" }],
} = {}) {
  return {
    async calendarHealth() {
      return { name: "calendar", installed: true, reachable: true, calendarCount: 2 };
    },
    async outlookHealth() {
      return { name: "outlook", installed: true, reachable: true, configured: true, inboxCount: listed.length };
    },
    async outlookListInbox() {
      return { ok: true, client: "outlook", total: listed.length, truncated: false, messages: listed };
    },
    async outlookGet({ id }) {
      const message = listed.find((item) => item.id === id);
      if (!message) throw Object.assign(new Error("missing"), { code: "outlook_not_found", status: 400 });
      return { ok: true, client: "outlook", message: { ...message, body: "Bounded body" } };
    },
    async outlookDraft(request) {
      drafts.push(request);
      return { ok: true, client: "outlook", drafted: true, sent: false, id: "draft-1", ...request };
    },
    async outlookSend(request) {
      sends.push(request);
      throw new Error("iMessage/Outlook send must not be used by the Lindy bridge");
    },
    async calendarList() {
      return {
        ok: true,
        client: "calendar",
        windowDays: 7,
        truncated: false,
        events: [{ id: "uid-1", calendar: "CVS", title: "1:1", start: "2026-08-18T10:00:00", end: "2026-08-18T10:30:00", location: "" }],
      };
    },
    async calendarUpsert(request) {
      return { ok: true, client: "calendar", id: request.id || "uid-created", created: !request.id, ...request };
    },
    async mailSend() {
      throw new Error("Apple Mail must not be used by the Lindy bridge");
    },
  };
}

export function testRuntime(localApps = mockLocalApps()) {
  return {
    policy: ownerPolicy(),
    emailAuthorizations: [personAuthorization()],
    localApps,
  };
}

export async function withServer(runtime, fn, allowlist = exampleAllowlist()) {
  const http = createBridgeHttpServer({
    runtime,
    allowlist,
    token: TOKEN,
    host: "127.0.0.1",
    port: 0,
  });
  const address = await http.listen();
  const base = `http://127.0.0.1:${address.port}/lindy/local-bridge`;
  try {
    return await fn(base);
  } finally {
    await http.close();
  }
}

export function authHeaders(token = TOKEN) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}
