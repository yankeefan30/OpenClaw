---
name: artist-produce-executive-deck
description: >
  One-click finished-deck production for The Artist. ALWAYS use when the user
  says Produce Executive Deck or asks for a complete board, CEO, ELT, or
  executive presentation with Slides, PPTX, and PDF. Ingests sources, builds
  brief through render, runs the mandatory Final Pre-Board Quality Gate, auto-
  revises up to three times, exports, and saves to Drive with no administrative
  confirmations. Never fabricates facts. Never shares externally unless asked.
icon: play
color: Green
related_server_ids: [gdrive, gslides, gsheets, excel]
---

# Produce Executive Deck

High-autonomy production command. No approval prompts during a normal run.

## Sequence

1. Ingest all supplied materials (`artist-intake`). Use Sheets or Excel automatically when present.
2. Copy the mandatory CVS Health 2025 Enterprise Template (`artist-templates`). Never create a substitute theme.
3. Build `deck_brief`, `storyline`, and `slides[]`.
4. Generate charts, diagrams, and visual directions (`artist-visual-system`).
5. Create the Drive tree if missing. Render the Google Slides deck in `Working Decks/`.
6. Run `artist-final-pre-board-quality-gate`.
7. Apply revised output. Re-render affected slides. Repeat up to three cycles.
8. If `approved` or `approved_with_minor_revisions`: automatically save working + final Slides, export PPTX and PDF, save JSON spec, quality report, revision log, source register, and manifest.
9. If `blocked_by_missing_evidence`: save the strongest labeled draft package and return `complete_with_evidence_gaps`.
10. If still below threshold after three cycles: save the current package as `requires_human_executive_review`.
11. Return links, IDs, quality score, governing thought, executive summary, decision ask, assumptions/gaps, and revision summary.

## Do not ask

Do not ask to create folders, create Slides, copy templates, write Drive files, export, promote to Final Decks, or run the quality gate. Only ask before changing Drive sharing or sending a file outside the workspace.

## Failures that may stop production

Connector failure, missing file access, render/export failure (`rendering_failed` with preserved artifacts), quality threshold missed after three cycles, or an external-share request without explicit instruction.
