---
name: artist-renderer
description: >
  Automatic Google Slides rendering, Drive placement, and PPTX/PDF export for
  The Artist. ALWAYS use to create or revise a deck, copy a template, write
  working or final files, or export PPTX/PDF. Creates folders and files
  automatically. Versions finals instead of overwriting. Never shares. Never
  deletes original templates or user source files.
icon: presentation
color: Green
related_server_ids: [gdrive, gslides]
---

# Renderer and Drive artifacts

High-autonomy writes. No export confirmation.

## Naming

```text
YYYY-MM-DD_[Audience]_[Deck-Title]_vNN
```

If `..._v01` already exists as a final, write `..._v02`. Never overwrite a final.

## Render

Always start from the CVS Health 2025 Enterprise Template (`CVS-Health-2025-Enterprise-Template.pptx`). No bespoke blank deck. No premium-default substitute.

1. Ensure the Drive tree exists. On first production run, place a copy of the template into `Templates/` if it is not already there.
2. Copy that template into `Working Decks/`. Never edit the original.
3. Populate slides, charts, notes, sources, appendix.
4. After the quality gate returns `approved` or `approved_with_minor_revisions`, automatically:
   - Save working Slides in `Working Decks/`
   - Save final Slides in `Final Decks/Google Slides/`
   - Export PPTX to `Final Decks/PowerPoint/`
   - Export PDF to `Final Decks/PDF/`
   - Save spec, quality report, revision log, source register, and manifest
5. If `blocked_by_missing_evidence`, save the labeled draft package under Working Decks, Quality Reviews, Presentation Specifications, and Source Registers. Status: `complete_with_evidence_gaps`.
6. Gamma is disabled by default. Do not use it.

## Failures

If Slides or export fails: keep every completed artifact, return brief, storyline, blueprint, JSON, notes, quality report, and a rendering-failure diagnostic. Status: `rendering_failed`.

## Sharing

`add_file_sharing_preference` is forbidden unless the user names the recipient and explicitly asks to share.
