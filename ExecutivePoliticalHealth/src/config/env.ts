import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const EnvSchema = z.object({
  NOTION_TOKEN: z.string().min(1),
  NOTION_DRY_RUN: z
    .string()
    .optional()
    .transform((v) => v === "1" || v?.toLowerCase() === "true"),
  NOTION_DASHBOARD_PAGE_ID: z.string().min(1),
  NOTION_DB_DAILY_ASSESSMENTS: z.string().min(1),
  NOTION_DB_STRATEGIC_RELATIONSHIPS: z.string().min(1),
  NOTION_DB_RELATIONSHIP_DAILY_ASSESSMENTS: z.string().min(1),
  NOTION_DB_DIMENSION_SCORES: z.string().min(1),
  NOTION_DB_INTERACTIONS: z.string().min(1),
  NOTION_DB_EVIDENCE_LEDGER: z.string().min(1),
  NOTION_DB_RISKS_OPPORTUNITIES: z.string().min(1),
  NOTION_DB_ACTIONS: z.string().min(1),
  NOTION_DB_ANALYSIS_RUNS: z.string().min(1),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  RETRY_BASE_MS: z.coerce.number().int().min(50).default(400),
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  dryRun: boolean;
};

export function loadConfig(overrides: Partial<Record<string, string>> = {}): AppConfig {
  const merged = { ...process.env, ...overrides };
  const parsed = EnvSchema.parse(merged);
  return {
    ...parsed,
    dryRun: Boolean(parsed.NOTION_DRY_RUN),
  };
}
