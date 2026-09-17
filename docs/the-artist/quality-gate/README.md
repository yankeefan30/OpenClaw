# The Artist — Final Pre-Board Quality Gate

Mandatory last quality-control skill for The Artist. It is an active rewriter, not a commenter.

## What it does

Reviews the latest presentation specification and any inspectable render. It rewrites weak titles and copy, rebuilds a weak executive summary, redesigns amateur layouts and charts, flags unsupported claims, and returns:

- `pre_board_quality_gate` report
- `revised_presentation` specification (the whole deck)
- `revision_log`
- `audit_event`
- `infographic_quality_review` when the artifact is an infographic or one-page visual

The agent must use the revised specification, not the commentary.

## Where it runs

After initial Google Slides or infographic rendering and render validation. Before final validation, user export approval, PPTX/PDF export, external sharing, promotion into `04_Final PPTX/` or `05_Final PDF/`, or any `final` / `exported` / `delivered` / `shared` / `completed` status.

It also inspects the pre-render blueprint so a dry-run package cannot be called final without the gate.

Editor-in-Chief still runs earlier as the first critic. This skill is the last substantive gate.

```text
intake → sources → brief → storyline → blueprint → charts → design →
initial render → render validation → QUALITY GATE →
revision loop (≤3) → final validation → user approval → export
```

## Approval thresholds

Configured in `thresholds.json`:

| Status | Threshold |
|---|---|
| `approved` | Overall ≥ 9.0, plus board-readiness / exec-summary / decision-clarity ≥ 9.0 when those apply, and no material integrity defects |
| `approved_with_minor_revisions` | Overall 8.5–8.9, no material risk/factual/financial/source/decision issue, revisions already applied |
| `revision_required` | Overall < 8.5 or a material story, visual, decision, or source defect remains |
| `blocked_by_missing_evidence` | The recommendation depends on missing or unsubstantiated evidence |
| `requires_human_executive_review` | Still below threshold after three automatic cycles |

## Revision behavior

If status is `revision_required`, apply the revised specification, re-render affected slides, and run the gate again. Maximum three automatic cycles. Do not invent facts, do not degrade truthfulness for visuals, and do not silently drop a user-provided material conclusion. Keep the original draft and every cycle’s report.

## User-approval boundaries

The gate may automatically change titles, structure, wording, density, layout recommendations, charts, hierarchy, appendix placement, speaker notes, and source/assumption labels.

It must ask before changing the material recommendation, investment amount, material forecast or risk estimate, a user-mandated issue, audience, or a new strategic option; before sharing, exporting finals, overwriting a final deck, editing a template, or treating assumptions as approved facts.

## Tuning board-readiness

Edit `quality-gate/thresholds.json` → `board_readiness_threshold` (default `9.0`). Use this only when the audience standard itself changes. Do not lower it to force an export. After changing the file, keep the live skill and this repo in sync.

## Emergency bypass

`emergency_bypass_enabled` defaults to `false`. Only an authorized workflow administrator may set it `true`, and only with a recorded `bypass_reason`, `bypass_approver`, and timestamp on the audit event. Bypass still requires the user’s approval before export or share. “Quick draft” is not a bypass; the gate still runs in reduced-duration mode.

## Drive locations

```text
The Artist/07_Quality Reviews/
  [Deck Name]_pre-board-quality-gate.json
  [Deck Name]_revision-log.json
  [Deck Name]_board-readiness-summary.md
The Artist/08_JSON Specifications/
  [Deck Name]_revised-presentation-spec.json
```

## Tests

From the repo root:

```bash
python3 -m unittest docs.the-artist.tests.test_pre_board_quality_gate
```

Or:

```bash
python3 docs/the-artist/tests/test_pre_board_quality_gate.py
```
