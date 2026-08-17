import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { authorizeWorkflowTool, loadWorkflowAllowlist, validateAllowlist } from "../allowlist.mjs";
import { exampleAllowlist } from "./helpers.mjs";

test("example allowlist is names-only and grants mail/calendar tools", () => {
  const raw = JSON.parse(fs.readFileSync(new URL("../allowlist.example.json", import.meta.url), "utf8"));
  const allowlist = validateAllowlist(raw);
  assert.equal(allowlist.people[0].name, "Alan Rosa");
  assert.equal(allowlist.people[0].role, "owner");
  assert.ok(allowlist.people.some((person) => person.name === "Janet Cummings"));
  assert.equal(JSON.stringify(raw).includes("@"), false);
  assert.equal(/\+\d/.test(JSON.stringify(raw)), false);
  assert.deepEqual(allowlist.workflows.map((item) => item.id), [
    "lindy-cvs-mail-read",
    "lindy-cvs-mail-draft",
    "lindy-cvs-calendar",
  ]);
});

test("allowlist rejects emails, phones, iMessage tools, and unknown tools", () => {
  assert.throws(() => validateAllowlist({
    schema: "rico.lindy-local-bridge-allowlist",
    schemaVersion: 1,
    people: [{ name: "Alan Rosa", role: "owner", email: "hidden@example.com" }],
    workflows: [{ id: "lindy-cvs-mail-read", tools: ["health"] }],
  }), { code: "allowlist_invalid" });
  assert.throws(() => validateAllowlist({
    schema: "rico.lindy-local-bridge-allowlist",
    schemaVersion: 1,
    workflows: [{ id: "lindy-imessage", tools: ["rico_imessage_send"] }],
  }), { code: "allowlist_invalid" });
  assert.throws(() => validateAllowlist({
    schema: "rico.lindy-local-bridge-allowlist",
    schemaVersion: 1,
    workflows: [{ id: "lindy-chat", tools: ["ask"] }],
  }), { code: "allowlist_invalid" });
});

test("workflow authorization fails closed for strangers and out-of-scope tools", () => {
  const allowlist = exampleAllowlist();
  assert.deepEqual(
    authorizeWorkflowTool({ allowlist, workflowId: "lindy-cvs-mail-read", tool: "outlook_get" }),
    { ok: true, workflowId: "lindy-cvs-mail-read", tool: "outlook_get" },
  );
  assert.throws(() => authorizeWorkflowTool({
    allowlist,
    workflowId: "unknown-workflow",
    tool: "outlook_get",
  }), { code: "workflow_not_allowlisted" });
  assert.throws(() => authorizeWorkflowTool({
    allowlist,
    workflowId: "lindy-cvs-mail-read",
    tool: "outlook_draft",
  }), { code: "tool_not_allowed" });
  assert.throws(() => authorizeWorkflowTool({
    allowlist,
    workflowId: "lindy-cvs-mail-read",
    tool: "rico_imessage_send",
  }), { code: "tool_not_allowed" });
});

test("missing allowlist file fails closed", () => {
  const missing = path.join(os.tmpdir(), `rico-lindy-missing-${process.pid}.json`);
  assert.throws(() => loadWorkflowAllowlist(missing), { code: "allowlist_unavailable" });
});
