import { Client } from "@notionhq/client";
import type {
  CreatePageParameters,
  PageObjectResponse,
  UpdatePageParameters,
} from "@notionhq/client/build/src/api-endpoints.js";
import type { AppConfig } from "../config/env.ts";
import type { Logger } from "../utils/logger.ts";
import { withRetry } from "../utils/retry.ts";
import { getExternalKeyFromPage } from "./properties.ts";

export type NotionDatabases = {
  dailyAssessments: string;
  strategicRelationships: string;
  relationshipDailyAssessments: string;
  dimensionScores: string;
  interactions: string;
  evidenceLedger: string;
  risksOpportunities: string;
  actions: string;
  analysisRuns: string;
};

export function databasesFromConfig(cfg: AppConfig): NotionDatabases {
  return {
    dailyAssessments: cfg.NOTION_DB_DAILY_ASSESSMENTS,
    strategicRelationships: cfg.NOTION_DB_STRATEGIC_RELATIONSHIPS,
    relationshipDailyAssessments: cfg.NOTION_DB_RELATIONSHIP_DAILY_ASSESSMENTS,
    dimensionScores: cfg.NOTION_DB_DIMENSION_SCORES,
    interactions: cfg.NOTION_DB_INTERACTIONS,
    evidenceLedger: cfg.NOTION_DB_EVIDENCE_LEDGER,
    risksOpportunities: cfg.NOTION_DB_RISKS_OPPORTUNITIES,
    actions: cfg.NOTION_DB_ACTIONS,
    analysisRuns: cfg.NOTION_DB_ANALYSIS_RUNS,
  };
}

export class NotionWriter {
  readonly client: Client;
  private pageCache = new Map<string, string>(); // `${dbId}::${externalKey}` -> pageId
  private cfg: AppConfig;
  private log: Logger;

  constructor(cfg: AppConfig, log: Logger, token = cfg.NOTION_TOKEN) {
    this.cfg = cfg;
    this.log = log;
    this.client = new Client({ auth: token });
  }

  async findByExternalKey(
    databaseId: string,
    externalKey: string,
  ): Promise<PageObjectResponse | null> {
    const cacheKey = `${databaseId}::${externalKey}`;
    const cached = this.pageCache.get(cacheKey);
    if (cached) {
      try {
        const page = (await this.withApi("pages.retrieve", () =>
          this.client.pages.retrieve({ page_id: cached }),
        )) as PageObjectResponse;
        if (!("properties" in page)) return null;
        return page;
      } catch {
        this.pageCache.delete(cacheKey);
      }
    }

    const response = await this.withApi("databases.query", () =>
      this.client.databases.query({
        database_id: databaseId,
        filter: {
          property: "External Key",
          rich_text: { equals: externalKey },
        },
        page_size: 5,
      }),
    );

    const pages = response.results.filter(
      (r): r is PageObjectResponse => r.object === "page" && "properties" in r,
    );

    if (pages.length === 0) return null;
    if (pages.length > 1) {
      this.log.warn("Multiple pages share External Key; using first", {
        databaseId,
        externalKey,
        count: pages.length,
      });
    }
    const page = pages[0]!;
    this.pageCache.set(cacheKey, page.id);
    return page;
  }

  async upsertByExternalKey(opts: {
    databaseId: string;
    externalKey: string;
    properties: CreatePageParameters["properties"];
    dryRun?: boolean;
  }): Promise<{ pageId: string; created: boolean; skipped: boolean }> {
    const dryRun = opts.dryRun ?? this.cfg.dryRun;
    const existing = await this.findByExternalKey(
      opts.databaseId,
      opts.externalKey,
    );

    if (dryRun) {
      this.log.info("dry-run upsert", {
        databaseId: opts.databaseId,
        externalKey: opts.externalKey,
        would: existing ? "update" : "create",
      });
      return {
        pageId: existing?.id ?? `dry-run:${opts.externalKey}`,
        created: !existing,
        skipped: false,
      };
    }

    if (existing) {
      await this.withApi("pages.update", () =>
        this.client.pages.update({
          page_id: existing.id,
          properties: opts.properties as UpdatePageParameters["properties"],
        }),
      );
      this.log.debug("updated page", {
        pageId: existing.id,
        externalKey: opts.externalKey,
      });
      return { pageId: existing.id, created: false, skipped: false };
    }

    const created = await this.withApi("pages.create", () =>
      this.client.pages.create({
        parent: { database_id: opts.databaseId },
        properties: opts.properties,
      }),
    );
    const pageId = created.id;
    this.pageCache.set(`${opts.databaseId}::${opts.externalKey}`, pageId);
    this.log.debug("created page", { pageId, externalKey: opts.externalKey });
    return { pageId, created: true, skipped: false };
  }

  async updateRelations(
    pageId: string,
    relationProps: Record<string, string[]>,
    dryRun?: boolean,
  ): Promise<void> {
    if (dryRun ?? this.cfg.dryRun) {
      this.log.info("dry-run relation update", { pageId, relationProps });
      return;
    }
    const properties: UpdatePageParameters["properties"] = {};
    for (const [name, ids] of Object.entries(relationProps)) {
      properties[name] = {
        relation: ids.map((id) => ({ id })),
      };
    }
    await this.withApi("pages.update.relations", () =>
      this.client.pages.update({ page_id: pageId, properties }),
    );
  }

  async updateProperties(
    pageId: string,
    properties: UpdatePageParameters["properties"],
    dryRun?: boolean,
  ): Promise<void> {
    if (dryRun ?? this.cfg.dryRun) {
      this.log.info("dry-run property update", {
        pageId,
        keys: Object.keys(properties ?? {}),
      });
      return;
    }
    await this.withApi("pages.update.properties", () =>
      this.client.pages.update({ page_id: pageId, properties }),
    );
  }

  remember(databaseId: string, externalKey: string, pageId: string) {
    this.pageCache.set(`${databaseId}::${externalKey}`, pageId);
  }

  resolveCached(databaseId: string, externalKey: string): string | undefined {
    return this.pageCache.get(`${databaseId}::${externalKey}`);
  }

  async resolveId(
    databaseId: string,
    externalKey: string,
  ): Promise<string | null> {
    const cached = this.resolveCached(databaseId, externalKey);
    if (cached && !cached.startsWith("dry-run:")) return cached;
    const page = await this.findByExternalKey(databaseId, externalKey);
    if (!page) return null;
    const key = getExternalKeyFromPage(page);
    if (key) this.remember(databaseId, key, page.id);
    return page.id;
  }

  private withApi<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, {
      maxAttempts: this.cfg.RETRY_MAX_ATTEMPTS,
      baseMs: this.cfg.RETRY_BASE_MS,
      label,
      onRetry: (attempt, err) => {
        this.log.warn("retrying Notion API call", {
          label,
          attempt,
          error: String((err as Error)?.message ?? err),
        });
      },
    });
  }
}
