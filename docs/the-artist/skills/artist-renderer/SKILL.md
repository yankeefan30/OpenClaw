---
name: artist-renderer
description: >
  Google Slides rendering, template copy, Drive artifact placement, and PPTX/PDF
  export for The Artist. ALWAYS use when the user approved creating a deck,
  copying a template, writing to Drive, or exporting PPTX/PDF. Never edit a
  template in place. Never share. Never write without explicit approval.
icon: presentation
color: Green
related_server_ids: [gdrive, gslides, gamma]
---

# Presentation renderer and Drive artifacts

Module 7 + export. Writes require approval. Google Slides is the primary canvas.

## Preflight

If `artist-setup` has not marked rendering active, run a read-only health check first.

- Slides unauthenticated → do not create files. Return `rendering_pending`, JSON/Markdown blueprint, and [Connect Google Slides](https://gumloop.com/settings/profile/apps?server=gslides).
- Drive unavailable → same dry-run. Do not claim save.
- Claude unavailable → do not render a half-reasoned deck.

## Naming

```text
YYYY-MM-DD_[Confidentiality]_[Audience]_[Deck-Title]_v01
```

Examples: `2026-09-16_Board-Confidential_Board_Cybersecurity-Transformation_v01`

Do not put confidential source text in filenames or public sharing metadata.

## Branch A — Template-driven

Use when the user chose a corporate or recurring template (board, cyber, operating review, executive) or brand consistency matters more than invention.

1. Locate the template in `01_Templates/` (or the user-supplied file).
2. `gdrive.copy_file` into `03_Working Decks/`. Never edit the original.
3. Rename with the controlled convention.
4. Populate title, sections, charts, tables, visuals, source notes, speaker notes, appendix.
5. After a second approval, export PPTX to `04_Final PPTX/` and PDF to `05_Final PDF/`.
6. Write JSON spec to `08_JSON Specifications/` and quality review to `07_Quality Reviews/`.

## Branch B — Bespoke

Use for CEO strategy, board strategy session, investment case, customer executive, special transformation, or when no template exists.

1. Create a new Google Slides presentation.
2. Apply the approved default visual system or user brand.
3. Build varied layouts from the blueprint.
4. Store working deck in `03_Working Decks/`.
5. Export finals only after approval.

If Slides tools are missing but the user confirmed a file and Drive works, optional fallback after a separate confirmation: Gamma `generate_gamma` with `textMode=preserve`, `textOptions.amount=brief`, `imageOptions.source=noImages` or `pictographic`, `exportAs=pptx`. Still do not claim a Slides URL.

## Export confirmation (required)

```text
Deck ready for export:

Title: [TITLE]
Audience: [AUDIENCE]
Decision ask: [DECISION]
Template/rendering mode: [MODE]
Slides: [COUNT]
Confidentiality: [LABEL]
Output locations:
- Working Google Slides deck: [LOCATION]
- PowerPoint export: [LOCATION]
- PDF export: [LOCATION]
- Quality review: [LOCATION]

Approve creation/export of the final PPTX and PDF artifacts?
```

Only after yes: export, save, build artifact manifest. If PPTX fails, keep the working Slides deck, attempt PDF only if independently available, and report each status. Never represent a failed export as complete.

## Sharing and overwrite

Default sharing: private to the authenticated user / selected org account. `add_file_sharing_preference` is forbidden unless the user names the recipient and approves. Never overwrite unless the user identifies the file and approves. Never modify a corporate template in place.

No-retention mode: delete working artifacts after export only when explicitly requested and approved.

## Missing template

Offer: default Premium Executive (bespoke), user template upload, or draft-only blueprint. Do not invent a corporate template.

## Errors

| Condition | Action |
|---|---|
| Slides 401 | `rendering_pending`; connect URL; no file claims |
| PPTX fail | Preserve Slides; report PPTX failed; PDF independent |
| Share requested | Confirm recipient, role, and scope first |
| Confidential / PHI / hold | Do not send to Gamma or any extra destination without destination-specific approval |
