---
name: artist-output-package
description: >
  Final output assembly and audit record for The Artist. ALWAYS use when
  packaging the deliverable, writing the artifact manifest, or producing
  PowerPoint-ready JSON. Records the CVS Health 2025 Enterprise Template as
  template_used. Does not share. Saves automatically after the quality gate.
icon: package
color: Green
---

# Output package and audit

Assemble the production package. Rendering stays in `artist-renderer`.

`template_used` is always `CVS Health 2025 Enterprise Template`. `rendering_mode` is `cvs_health_2025_enterprise` or `dry_run`.

Default package is a finished deck, not an outline. After quality-gate `approved` or `approved_with_minor_revisions`, IDs must point at saved Slides, PPTX, PDF, spec, quality report, and source register. After `blocked_by_missing_evidence`, save the labeled draft and set `complete_with_evidence_gaps`.

Return: Slides link, PPTX, PDF, quality score, governing thought, executive summary, decision ask, assumptions/gaps, revision summary, source register, manifest, audit record.

`audit_record` includes request ID, timestamp, user, source artifact IDs, model used, template used (`cvs-health-2025-enterprise`), Drive IDs, export IDs, quality score. No secrets.

| Condition | Action |
|---|---|
| No quality-gate report | Run `artist-final-pre-board-quality-gate` first |
| Render/export failed | Preserve narrative artifacts; status `rendering_failed` |
| Drive save failed | Do not claim save; keep chat artifacts |
