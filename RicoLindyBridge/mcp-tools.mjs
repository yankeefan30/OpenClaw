import {
  MAX_CALENDAR_DAYS,
  MAX_CALENDAR_NOTES_CHARS,
  MAX_CALENDAR_TITLE_CHARS,
  MAX_INBOX_ITEMS,
  MAX_MAIL_BODY_CHARS,
  MAX_SUBJECT_CHARS,
} from "../RicoIMessageMCP/constants.mjs";
import { MCP_WORKFLOW_ID } from "./constants.mjs";

const workflowId = {
  type: "string",
  minLength: 1,
  maxLength: 80,
  description: `Allowlisted Lindy workflow id. Defaults to ${MCP_WORKFLOW_ID} when omitted.`,
};

export const MCP_TOOL_DEFINITIONS = Object.freeze([
  {
    name: "health",
    description: "Report whether local Microsoft Outlook and Calendar.app are reachable on original Rico. No tokens or account IDs. iMessage is disabled.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { workflowId },
      required: [],
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "outlook_list_inbox",
    description: "List a bounded number of recent CVS Outlook inbox messages (metadata only) on original Rico. Does not send.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workflowId,
        limit: { type: "integer", minimum: 1, maximum: MAX_INBOX_ITEMS },
      },
      required: [],
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "outlook_search",
    description: "Filter the bounded CVS Outlook inbox list by subject or from. Does not send.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        workflowId,
        query: { type: "string", minLength: 1, maxLength: 80 },
        limit: { type: "integer", minimum: 1, maximum: MAX_INBOX_ITEMS },
      },
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "outlook_get",
    description: "Get one CVS Outlook inbox message by id from a previous list. Body is truncated. Does not send.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        workflowId,
        id: { type: "string", minLength: 1, maxLength: 32 },
      },
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "outlook_draft",
    description: "Create one CVS Outlook draft to an approved recipient on original Rico. Does not send. Strangers are rejected.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["to", "subject", "text"],
      properties: {
        workflowId,
        to: { type: "string", minLength: 3, maxLength: 254, description: "Approved recipient from the local person-email authorization file." },
        from: { type: "string", minLength: 3, maxLength: 254 },
        subject: { type: "string", minLength: 1, maxLength: MAX_SUBJECT_CHARS },
        text: { type: "string", minLength: 1, maxLength: MAX_MAIL_BODY_CHARS },
      },
    },
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "calendar_list",
    description: "List upcoming Calendar.app events in a bounded window on original Rico. No attendees.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workflowId,
        days: { type: "integer", minimum: 1, maximum: MAX_CALENDAR_DAYS },
        calendar: { type: "string", minLength: 1, maxLength: 80 },
      },
      required: [],
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "calendar_upsert",
    description: "Create or update one local Calendar.app event. No attendees are invited. Not a meeting send.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["calendar", "title", "start", "end"],
      properties: {
        workflowId,
        id: { type: "string", minLength: 1, maxLength: 256 },
        calendar: { type: "string", minLength: 1, maxLength: 80 },
        title: { type: "string", minLength: 1, maxLength: MAX_CALENDAR_TITLE_CHARS },
        start: { type: "string", minLength: 10, maxLength: 40 },
        end: { type: "string", minLength: 10, maxLength: 40 },
        notes: { type: "string", maxLength: MAX_CALENDAR_NOTES_CHARS },
        location: { type: "string", maxLength: 160 },
      },
    },
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
]);
