# Database schema reference

Property types match the live Notion workspace. Automation writes only mutable properties — never formulas or rollups.

## Daily Assessments

| Property | Type | Notes |
|----------|------|-------|
| Name | Title | `Political Health — YYYY-MM-DD` |
| Assessment Date | Date | America/New_York calendar date |
| External Key | Rich text | `political-health:YYYY-MM-DD` |
| Overall Score | Number | Claude composite 0–100 |
| Health Band | Select | Strong / Healthy / Watch / At Risk / Insufficient Evidence |
| Prior Day Score | Number | |
| 7-Day Trend Delta | Number | |
| 30-Day Trend Delta | Number | |
| Trend Direction | Select | Improving / Stable / Declining / Volatile / Insufficient Data |
| Confidence | Number | 0–100 |
| Source Coverage | Number | 0–100 |
| Evidence Count | Number | |
| Executive Readout | Rich text | One sentence preferred |
| What Changed / Key Wins / Key Risks / Top Actions / Signals to Verify | Rich text | |
| Human Review Required | Checkbox | |
| Human Review Status | Select | Not Required / Pending / Reviewed / Overridden |
| Analyst Version / Run ID | Rich text | Required on all automated rows |
| Analysis Timestamp / Data Window Start / End / Last Automated Update | Date | |
| Relationship Assessments | Relation ↔ Relationship Daily Assessments | |
| Political Risks | Relation ↔ Risks & Opportunities | |
| Recommended Actions | Relation ↔ Actions | |
| Evidence | Relation ↔ Evidence Ledger | |
| Dimension Scores | Relation ↔ Dimension Scores | |

## Strategic Relationships

| Property | Type | Notes |
|----------|------|-------|
| Name | Title | Person display name |
| External Key | Rich text | `person:<slug>` |
| Organization / Function, Role / Title | Rich text | |
| Relationship Type | Multi-select | Manager / Direct Report / Peer / … |
| Strategic Tier | Select | Tier 1–3 / Monitor |
| Influence Level / Decision Proximity | Number | 1–5 |
| Relationship Owner | Rich text | Human-owned |
| Relationship Objective / Current Narrative / Known Priorities / Preferred Engagement Style / Sensitivities / Constraints / Do Not Infer / Human Context Notes | Rich text | **Protected** |
| Current Relationship Health | Number | Synced from latest meaningful assessment |
| Health Band | Formula | Score band display |
| 7-Day Trend / 30-Day Trend | Number | |
| Last Meaningful Interaction / Next Intended Touchpoint | Date | Touchpoint protected |
| Stale Signal | Formula | Unknown / Stale / Current (>14 days) |
| Relations | Assessments, Interactions, Risks, Actions, Evidence | Dual where applicable |
| Active Risk Count / Open Action Count / Relationship Score Average | Rollup | Read-only |

## Relationship Daily Assessments

One row per person per date **only when meaningful evidence or material score change**.

Key: `relationship-assessment:<person_external_key>:YYYY-MM-DD`

Scores: Daily Score, Engagement Quality, Trust / Credibility, Alignment, Influence / Sponsorship, Responsiveness / Reciprocity (0–100). Risk Level select. Relations to Relationship, Daily Assessment, Evidence, Actions.

## Dimension Scores

Key: `dimension:<slug>:YYYY-MM-DD`

Dimensions (select): Sponsor confidence, Stakeholder alignment, Relationship capital, Influence and visibility, Delivery credibility, Organizational intelligence, Conflict and risk management.

## Interactions

Key = source unique ID (`limitless:…`, `plaud:…`, `email:…`, `manual:…`).

Source System, Interaction Type, Participants (relation), Topics, Summary / Decisions / Commitments, Sentiment / Tone, Evidence Quality, Raw Content Location (URL only), Included in Analysis.

## Evidence Ledger

Key: `evidence:…`. Redacted Evidence Snippet ≤500 chars. Analyst Interpretation separate. Verification Status. Sensitive Content Flag. Relations to Interaction, People, Daily Assessment, Relationship Assessment, Dimension Score.

## Risks & Opportunities

Type / Status / Severity / Likelihood / Strategic Impact. Human Review Required auto for High/Critical.

## Actions

Action Type / Priority / Status. Suggested Language only refreshed while Status = Suggested.

## Analysis Runs

Key: `run:<run_id>`. Status Started → Succeeded | Partial | Failed | Needs Review.
