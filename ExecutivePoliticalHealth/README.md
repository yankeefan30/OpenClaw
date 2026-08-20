# Executive Political Health Importer

Idempotent Notion SDK importer for the **Executive Political Health** dashboard — a private, evidence-grounded relationship-and-influence operating system (not a task tracker).

## Live Notion workspace

Dashboard: [Executive Political Health](https://www.notion.so/3c26d6fb226f8147956dee7f44e486a2)

Provisioned databases, formulas, rollups, dual relations, linked views, and a Weekly Review child page are documented in `docs/`.

## Architecture (quick)

```
Limitless / Plaud / Email / Manual
        ↓
  Aggregator agent (external)
        ↓
  Claude structured daily JSON
        ↓  05:00 America/New_York
  This importer (Zod validate → upsert by External Key)
        ↓
  Notion databases + dashboard views
```

## Project layout

```
ExecutivePoliticalHealth/
├── src/
│   ├── cli.ts
│   ├── config/env.ts
│   ├── schemas/payload.ts          # Zod contract
│   ├── importer/dailyImport.ts     # Orchestrated upserts
│   ├── notion/{properties,upsert}.ts
│   └── utils/{logger,retry,scoreBands,reviewFlags}.ts
├── fixtures/sample-daily-payload.json
├── tests/schema.test.ts
├── docs/
│   ├── WORKSPACE_BUILD_PLAN.md
│   ├── DATABASE_SCHEMA.md
│   ├── SETUP_CHECKLIST.md
│   ├── PAGE_LAYOUT.md
│   ├── INTEGRATION_SPEC.md
│   ├── ACCEPTANCE_CRITERIA.md
│   └── notion-ids.json
├── .env.example
└── package.json
```

## Setup

1. Copy env: `cp .env.example .env`
2. Create a Notion internal integration at https://www.notion.so/my-integrations
3. Share the dashboard page **and every child database** with the integration
4. Paste the integration secret into `NOTION_TOKEN`
5. Confirm database IDs in `.env` match `docs/notion-ids.json`
6. Install: `npm install`
7. Validate fixture: `npm run validate -- --file fixtures/sample-daily-payload.json`
8. Dry-run: `npm run import:dry-run -- --file fixtures/sample-daily-payload.json`
9. Live import: `npm run import -- --file /path/to/daily.json`

Full checklist: `docs/SETUP_CHECKLIST.md`

## Schedule (05:00 America/New_York)

Example cron (on a host with Node 22+ and secrets loaded):

```cron
0 5 * * * cd /opt/executive-political-health && /usr/bin/node --experimental-strip-types src/cli.ts --file /var/political-health/inbound/$(TZ=America/New_York date +\%Y-\%m-\%d).json >> /var/log/eph-import.log 2>&1
```

Or use GitHub Actions / Cloud Scheduler with the same command and `NOTION_TOKEN` secret.

## Idempotency & safety

| Rule | Behavior |
|------|----------|
| External Key | Lookup → update or create; never delete history |
| Protected relationship fields | Seed only when empty; never blank-overwrite |
| Action status | After `Suggested`, human status is preserved |
| Evidence | ≤500-char redacted snippets only |
| Review gates | Auto-set Human Review Required for large score moves, Tier1 <60, High/Critical risks, coverage <60, material confidence <55 |
| Dry-run | `NOTION_DRY_RUN=true` or `--dry-run` |
| Retries | Exponential backoff on 429 / 5xx / timeouts |

## Tests

```sh
npm test
npm run typecheck
```

## Assumptions

Labeled in `docs/WORKSPACE_BUILD_PLAN.md` (A1–A8). Placeholders use `person:<slug>` and `https://secure.example/...` for raw content locations.

## Runbook (failures)

1. Check Analysis Runs row for the `run_id` — Status / Error Detail / Notion Write Status  
2. Re-run the same payload (idempotent) after fixing auth or transient errors  
3. If Partial: inspect Error Detail lines (`person:…`, `evidence:…`) and re-import  
4. Never manually delete historical Daily Assessments to “fix” a bad run — write a corrected upsert instead  
5. Escalate Human Review Required rows before acting on High/Critical risks  

## Privacy

Do not store protected characteristics, private life, medical data, political affiliation, personality labels, loyalty assertions, or rumors as facts. Unknown is valid and non-punitive.
