---
name: artist-output-package
description: >
  Final output assembly and audit record for The Artist. ALWAYS use when
  packaging the deliverable, choosing Mode 1-4, writing the artifact manifest,
  or producing PowerPoint-ready JSON. Does not render or share. Sets
  rendering_pending when Slides or Drive writes were not approved or not
  possible.
icon: package
color: Green
---

# Output package and audit

Module 9. Assemble only. Rendering stays in `artist-renderer`.

## Modes

| Mode | When | Package |
|---|---|---|
| 1 Outline | Sparse sources or strategy-first | Objective, governing thought, storyline, answer-first titles, decision ask, open questions |
| 2 Full blueprint | Default | Slide specs, visuals, notes, sources, appendix plan, editor_review |
| 3 Structured payload | JSON or upcoming render | `presentation` JSON per schema (title, layout, text, shapes, tables, charts, image placeholders, notes, sources, accessibility) |
| 4 Critic / redesign | Existing deck supplied | Assessment, rewritten titles, redesign plan, board-readiness, revised blueprint |

## Manifest

Return `artist_output_package`. Empty string IDs when no file was created. `deck_status` is `draft` or `rendering_pending` unless approved render/export succeeded.

Also return, in prose the user can use immediately:

1. Executive summary
2. Slide outline
3. Full blueprint or requested mode
4. Speaker notes
5. Source and assumption register
6. Appendix plan
7. Board-readiness score
8. Optional presentation JSON
9. Slides URL / Drive IDs only if they exist
10. Audit record

## Audit record

Create `audit_record` with request ID, timestamp, user, source artifact IDs, model used, template used, generated Drive file IDs, export file IDs, approval events, quality score. No secrets, no raw source dumps in the audit filename.

## Errors

| Condition | Action |
|---|---|
| No editor_review | Run `artist-editor-in-chief` first; do not package |
| Render not approved | IDs empty; status `draft` or `rendering_pending` |
| Drive save failed | Do not claim save; keep chat artifacts |
