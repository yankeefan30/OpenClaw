# Executive Political Health — Workspace Build Plan

## Purpose

A private, evidence-grounded executive operating system for **organizational relationship health, influence, alignment, sponsorship, delivery credibility, and emerging political risk**. It is not a task tracker.

Daily pipeline (America/New_York):

1. Sources (Limitless, Plaud, Email metadata/excerpts, Manual) → aggregator agent
2. Claude produces structured daily assessment JSON
3. Notion importer upserts at **05:00 America/New_York**

## Assumptions (labeled)

| ID | Assumption |
|----|------------|
| A1 | Single executive private workspace; page stays Private / limited share |
| A2 | Person identity key format: `person:<stable-slug-or-uuid>` |
| A3 | Claude computes composite overall score; Notion stores it and only derives display bands |
| A4 | Manual fields on Strategic Relationships are never overwritten by automation |
| A5 | Raw transcripts/email bodies remain outside Notion; only ≤500-char redacted snippets |
| A6 | Notion External Key uniqueness is enforced by importer lookup (Notion has no unique constraint API) |
| A7 | Optional Topics multi-select values may be extended in Notion UI without code changes |
| A8 | Integration bot has edit access to the dashboard page and all child databases |

## Information architecture

```
Executive Political Health (Dashboard Page)
├── Today / What Changed / Actions / Attention / Momentum / Risks / Follow-ups / Signals
├── Legend + Evidence standards
├── Linked database views (11)
├── Weekly Review (child page)
└── Databases
    ├── Daily Assessments
    ├── Strategic Relationships
    ├── Relationship Daily Assessments
    ├── Dimension Scores
    ├── Interactions
    ├── Evidence Ledger
    ├── Risks & Opportunities
    ├── Actions
    └── Analysis Runs
```

## Idempotency keys

| Entity | External Key pattern |
|--------|----------------------|
| Daily Assessment | `political-health:YYYY-MM-DD` |
| Relationship Assessment | `relationship-assessment:<person_external_key>:YYYY-MM-DD` |
| Dimension Score | `dimension:<dimension-slug>:YYYY-MM-DD` |
| Interaction | source system ID (e.g. `limitless:<id>`, `plaud:<id>`, `email:<thread-id>`, `manual:<uuid>`) |
| Evidence | `evidence:<stable-hash-or-uuid>` |
| Risk/Opportunity | `risk:<stable-id>` / `opportunity:<stable-id>` |
| Action | `action:<stable-id>` |
| Analysis Run | `run:<run_id>` |
| Person | `person:<stable-slug-or-uuid>` |

## Write order

1. People (Strategic Relationships) — create/update non-protected fields only  
2. Interactions  
3. Evidence (without optional reverse relations if needed)  
4. Daily Assessment  
5. Dimension Scores  
6. Relationship Daily Assessments  
7. Risks & Opportunities  
8. Actions  
9. Apply/refresh relations  
10. Analysis Run status  

## Protected human fields (never blank-overwrite)

Strategic Relationships: Relationship Objective, Current Narrative, Known Priorities, Preferred Engagement Style, Sensitivities / Constraints, Do Not Infer, Human Context Notes, Next Intended Touchpoint, Relationship Owner, Relationship Type, Strategic Tier (when human-set — importer only fills if empty on create).

Actions: Status transitions after Accepted are human-owned; automation may create Suggested rows and refresh Why Now / Suggested Language only while Status = Suggested.

## Human review triggers

Set `Human Review Required` when any of:

- Overall score absolute delta > 10  
- Any Tier 1 relationship daily score < 60  
- Any High or Critical risk  
- Source coverage < 60  
- Confidence < 55 on any material claim (overall assessment, Tier 1 relationship, High/Critical risk, High/Critical severity evidence)

## Privacy / ethics guardrails

- No protected characteristics, private life, medical data, political affiliation, personality labels  
- No asserted hidden motives, loyalty, intent, or rumors as facts  
- Distinguish evidence snippet vs analyst interpretation  
- Unknown is valid and non-punitive  

## Live Notion IDs (provisioned)

See `docs/notion-ids.json` and `.env.example`.
