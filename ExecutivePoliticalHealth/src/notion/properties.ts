import type {
  PageObjectResponse,
  RichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints.js";

export function title(content: string) {
  return {
    title: [{ type: "text" as const, text: { content: truncate(content, 2000) } }],
  };
}

export function richText(content: string | undefined | null) {
  if (content === undefined || content === null) return undefined;
  return {
    rich_text: [
      { type: "text" as const, text: { content: truncate(content, 2000) } },
    ],
  };
}

export function numberProp(value: number | null | undefined) {
  if (value === undefined) return undefined;
  return { number: value };
}

export function checkbox(value: boolean | undefined) {
  if (value === undefined) return undefined;
  return { checkbox: value };
}

export function select(name: string | undefined | null) {
  if (name === undefined || name === null || name === "") return undefined;
  return { select: { name } };
}

export function multiSelect(names: string[] | undefined) {
  if (!names) return undefined;
  return { multi_select: names.map((name) => ({ name })) };
}

export function dateProp(
  start: string | undefined | null,
  opts: { datetime?: boolean } = {},
) {
  if (start === undefined || start === null || start === "") return undefined;
  return {
    date: {
      start,
      ...(opts.datetime ? {} : {}),
    },
  };
}

export function urlProp(url: string | undefined | null) {
  if (url === undefined) return undefined;
  if (!url) return { url: null };
  return { url };
}

export function relation(ids: string[] | undefined) {
  if (!ids) return undefined;
  return { relation: ids.map((id) => ({ id })) };
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

export function plainTextFromRich(
  items: RichTextItemResponse[] | undefined,
): string {
  if (!items?.length) return "";
  return items.map((i) => i.plain_text).join("");
}

export function getExternalKeyFromPage(
  page: PageObjectResponse,
  propertyName = "External Key",
): string | null {
  const prop = page.properties[propertyName];
  if (!prop || prop.type !== "rich_text") return null;
  const text = plainTextFromRich(prop.rich_text).trim();
  return text || null;
}

export function getSelectName(
  page: PageObjectResponse,
  propertyName: string,
): string | null {
  const prop = page.properties[propertyName];
  if (!prop || prop.type !== "select") return null;
  return prop.select?.name ?? null;
}

export function getRichText(
  page: PageObjectResponse,
  propertyName: string,
): string {
  const prop = page.properties[propertyName];
  if (!prop || prop.type !== "rich_text") return "";
  return plainTextFromRich(prop.rich_text);
}

/**
 * Merge properties for update: skip undefined, skip blank strings over non-empty existing
 * protected fields, never write rollup/formula.
 */
export function mergeSkipBlank(
  incoming: Record<string, unknown>,
  existingProtected: Record<string, string>,
  protectedKeys: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (protectedKeys.includes(key)) {
      const existing = existingProtected[key] ?? "";
      const incomingText = extractTextish(value);
      if (existing.trim() && (!incomingText || !incomingText.trim())) {
        continue;
      }
      // Never overwrite non-empty human text with automation content for protected keys
      // except when existing is empty (seed on create path handled separately).
      if (existing.trim()) {
        continue;
      }
    }
    out[key] = value;
  }
  return out;
}

function extractTextish(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const v = value as {
    rich_text?: Array<{ text?: { content?: string } }>;
    title?: Array<{ text?: { content?: string } }>;
  };
  if (v.rich_text) return v.rich_text.map((t) => t.text?.content ?? "").join("");
  if (v.title) return v.title.map((t) => t.text?.content ?? "").join("");
  return "";
}

/** Strategic relationship fields humans own. */
export const PROTECTED_RELATIONSHIP_PROPS = [
  "Relationship Objective",
  "Current Narrative",
  "Known Priorities",
  "Preferred Engagement Style",
  "Sensitivities / Constraints",
  "Do Not Infer",
  "Human Context Notes",
  "Next Intended Touchpoint",
  "Relationship Owner",
] as const;
