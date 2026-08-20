# Test plan & acceptance criteria

## Automated tests (`npm test`)

- [x] Sample payload validates  
- [x] Snippet length hard-fail >500  
- [x] Score band mapping  
- [x] Trend arrow only when delta present  
- [x] Review flag rules  
- [x] Protected field blank-skip  
- [x] Retry classification  
- [x] External key patterns  
- [x] Relation referential integrity inside payload  
- [x] Partial-failure payload still valid after dropping entities  

## Manual acceptance

| # | Criterion | Pass condition |
|---|-----------|----------------|
| 1 | Dashboard exists | Executive can open “Executive Political Health” privately |
| 2 | Today section readable | Score, band, trends, coverage, readout visible |
| 3 | Linked views | All 10+ linked views render without permission errors |
| 4 | Idempotent re-import | Second import of same fixture updates rows; no duplicates by External Key |
| 5 | Protected fields | Human Context Notes survive re-import |
| 6 | Action status lock | After setting Status=Accepted, re-import does not revert to Suggested |
| 7 | Evidence privacy | No full transcripts in Notion; snippets ≤500 |
| 8 | Review gates | Tier1 <60 and High risk mark Human Review Required |
| 9 | Analysis Run audit | Run row shows status, coverage, error detail |
| 10 | Unknown ≠ negative | Missing score → Insufficient Evidence band, not At Risk |
| 11 | Ethics | No protected-class fields exist in schema |
| 12 | Schedule | Importer documented for 05:00 America/New_York |

## Performance / ops smoke

- Dry-run completes < 30s for sample fixture  
- Live sample import completes with Status ≠ Failed  
- Rate-limit retries do not crash the process  
