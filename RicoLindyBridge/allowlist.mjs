import fs from "node:fs";
import { BRIDGE_TOOLS, FORBIDDEN_TOOLS } from "./constants.mjs";
import { fail } from "./errors.mjs";

const SCHEMA = "rico.lindy-local-bridge-allowlist";
const WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const APPROVED_ROLES = new Set(["owner", "vip", "approved"]);

export function loadWorkflowAllowlist(filePath) {
  if (!filePath) {
    throw fail("allowlist_unavailable", "Lindy workflow allowlist is unavailable.", { status: 403 });
  }
  let parsed;
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw fail("allowlist_unavailable", "Lindy workflow allowlist is unavailable.", { status: 403 });
    }
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "allowlist_unavailable" || error?.code === "allowlist_invalid") throw error;
    throw fail("allowlist_unavailable", "Lindy workflow allowlist is unavailable.", { status: 403 });
  }
  return validateAllowlist(parsed);
}

export function validateAllowlist(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw fail("allowlist_invalid", "Lindy workflow allowlist is invalid.", { status: 403 });
  }
  if (parsed.schema !== SCHEMA || parsed.schemaVersion !== 1) {
    throw fail("allowlist_invalid", "Lindy workflow allowlist is invalid.", { status: 403 });
  }
  if (!Array.isArray(parsed.workflows) || parsed.workflows.length < 1) {
    throw fail("allowlist_invalid", "Lindy workflow allowlist is invalid.", { status: 403 });
  }

  const people = Array.isArray(parsed.people) ? parsed.people.map(validatePerson) : [];
  const seenPeople = new Set();
  for (const person of people) {
    if (seenPeople.has(person.name)) {
      throw fail("allowlist_invalid", "Lindy workflow allowlist is invalid.", { status: 403 });
    }
    seenPeople.add(person.name);
  }

  const workflows = parsed.workflows.map(validateWorkflow);
  const seenIds = new Set();
  for (const workflow of workflows) {
    if (seenIds.has(workflow.id)) {
      throw fail("allowlist_invalid", "Lindy workflow allowlist is invalid.", { status: 403 });
    }
    seenIds.add(workflow.id);
  }

  return Object.freeze({
    schema: SCHEMA,
    schemaVersion: 1,
    people: Object.freeze(people),
    workflows: Object.freeze(workflows),
  });
}

export function authorizeWorkflowTool({ allowlist, workflowId, tool }) {
  const id = String(workflowId ?? "").trim();
  const name = String(tool ?? "").trim();
  if (!WORKFLOW_ID.test(id)) {
    throw fail("workflow_not_allowlisted", "That Lindy workflow is not allowlisted.", { status: 403 });
  }
  if (FORBIDDEN_TOOLS.includes(name) || !BRIDGE_TOOLS.includes(name)) {
    throw fail("tool_not_allowed", "That tool is not on the Lindy local-bridge surface.", { status: 403 });
  }
  const workflow = allowlist?.workflows?.find((item) => item.id === id);
  if (!workflow) {
    throw fail("workflow_not_allowlisted", "That Lindy workflow is not allowlisted.", { status: 403 });
  }
  if (!workflow.tools.includes(name)) {
    throw fail("tool_not_allowed", "That Lindy workflow may not call this tool.", { status: 403 });
  }
  return { ok: true, workflowId: id, tool: name };
}

function validatePerson(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw fail("allowlist_invalid", "Lindy workflow allowlist is invalid.", { status: 403 });
  }
  const name = String(item.name ?? "").normalize("NFC").trim();
  const role = String(item.role ?? "").trim();
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name) || !APPROVED_ROLES.has(role)) {
    throw fail("allowlist_invalid", "Lindy workflow allowlist is invalid.", { status: 403 });
  }
  if (item.email || item.phone || item.number || item.handle || item.token) {
    throw fail("allowlist_invalid", "Lindy workflow allowlist must not contain emails, phones, or secrets.", { status: 403 });
  }
  return Object.freeze({ name, role });
}

function validateWorkflow(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw fail("allowlist_invalid", "Lindy workflow allowlist is invalid.", { status: 403 });
  }
  const id = String(item.id ?? "").trim();
  if (!WORKFLOW_ID.test(id)) {
    throw fail("allowlist_invalid", "Lindy workflow allowlist is invalid.", { status: 403 });
  }
  if (!Array.isArray(item.tools) || item.tools.length < 1) {
    throw fail("allowlist_invalid", "Lindy workflow allowlist is invalid.", { status: 403 });
  }
  const tools = item.tools.map((tool) => String(tool ?? "").trim());
  if (new Set(tools).size !== tools.length) {
    throw fail("allowlist_invalid", "Lindy workflow allowlist is invalid.", { status: 403 });
  }
  for (const tool of tools) {
    if (FORBIDDEN_TOOLS.includes(tool) || !BRIDGE_TOOLS.includes(tool)) {
      throw fail("allowlist_invalid", "Lindy workflow allowlist includes a tool that is not on this surface.", { status: 403 });
    }
  }
  return Object.freeze({ id, tools: Object.freeze(tools) });
}
