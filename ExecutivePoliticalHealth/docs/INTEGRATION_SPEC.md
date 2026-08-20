# Notion API integration specification

## Auth

- Notion Internal Integration token via `NOTION_TOKEN`
- All target pages/databases shared with the integration

## Contract

Upstream Claude/analyst emits JSON matching `DailyPayloadSchema` (`src/schemas/payload.ts`), `schema_version: "1.0.0"`.

Timezone for `analysis_date` and schedule: **America/New_York**.

## Idempotent upsert algorithm

For each entity:

1. `databases.query` filter `External Key` rich_text equals key  
2. If found → `pages.update` with automation fields  
3. If not found → `pages.create` under the database  
4. Never `pages.delete` / archive historical rows  

### Write order

1. Analysis Run (Started)  
2. People  
3. Interactions  
4. Evidence  
5. Daily Assessment  
6. Dimension Scores  
7. Relationship Daily Assessments (+ person health metric patch)  
8. Risks & Opportunities  
9. Actions  
10. Daily Assessment relation aggregation  
11. Analysis Run final status  

### Properties never written

- All Formula properties (`Health Band`, `Stale Signal` on people)  
- All Rollup properties  
- Notion system timestamps except our `Last Automated Update`  

### Partial failure

Each entity upsert is try/catch isolated. Failures append to Analysis Run `Error Detail`. Status becomes `Partial` if any writes succeeded, else `Failed`.

### Dry-run

`NOTION_DRY_RUN=true` or `--dry-run` logs intended create/update without mutating Notion (except optional read queries for existence checks).

### Logging

Structured JSON logs. Secrets, tokens, and long bodies redacted (`src/utils/logger.ts`).

### Retries

Exponential backoff: `RETRY_BASE_MS * 2^(attempt-1)` with jitter; max `RETRY_MAX_ATTEMPTS`. Retries on 429, 5xx, timeouts.

## Human review automation

Set `Human Review Required` when:

| Condition | Code |
|-----------|------|
| \|overall − prior\| > 10 | `overall_score_delta_gt_10` |
| Tier 1 daily score < 60 | `tier1_score_lt_60` |
| High or Critical risk | `high_or_critical_risk` |
| Source coverage < 60 | `source_coverage_lt_60` |
| Material confidence < 55 | `*_confidence_lt_55` |

## SDK

`@notionhq/client` official JavaScript SDK. Node ≥ 22.18.
