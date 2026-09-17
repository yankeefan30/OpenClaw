# The Artist — Architecture

```text
Claude = executive reasoning and narrative intelligence
Gumloop = workflow orchestration, tools, approvals, validation, automation
Google Drive = templates, sources, working documents, final outputs
Google Slides = presentation canvas and rendering engine
PowerPoint / PDF = executive distribution formats
```

Gumloop MCP cannot build a canvas node graph. The production system is an agent, nine skills, prompt assets, and JSON contracts. Skills are the modules. The system prompt is the router.

**Agent:** The Artist  
**Tagline:** Turn complex thinking into decisive executive stories.

## Module map

| # | Module | Implementation | Output |
|---|---|---|---|
| 0 | Setup and activation | `artist-setup` | Health checks, readiness report, optional folder tree, activation state |
| — | Connector readiness | `artist-setup` | `artist_readiness_report` |
| 1 | Presentation intake | `artist-intake` | Normalized request |
| 2 | Source ingestion | `artist-intake` | `source_register` |
| 3 | Intake Strategist | Claude + intake skill | `deck_brief` |
| 4 | Storyline Architect | Claude + `artist-storyline` | `storyline` |
| 5 | Slide Architect | Claude + `artist-slide-blueprint` | `slides[]` |
| 6 | Design Director | Claude + `artist-visual-system` | Theme, layouts, charts |
| 7 | Renderer | `artist-renderer` | Template copy or bespoke Slides |
| 7+ | Drive + export | `artist-renderer` | Working deck, PPTX, PDF, JSON, review files |
| 8 | Editor-in-Chief | Claude + `artist-editor-in-chief` | `editor_review` + revised slides |
| 9 | Output package | `artist-output-package` | Modes 1–4 + audit |

Prompt assets: `docs/the-artist/prompts/`. Schemas: `docs/the-artist/schemas/`.

## Data flow

```
Setup (read-only) → readiness
        │
User request + sources
        ▼
source_register → deck_brief → storyline
        │
        ├─ Mode 1 outline ─► stop
        ▼
slides[] → design/charts → editor_review
        ▼
output package (draft)
        │
        └─ [approvals] → Slides render → Drive save → PPTX/PDF → manifest
```

## Rendering branches

- **Template-driven (mandatory):** copy `CVS-Health-2025-Enterprise-Template.pptx`, populate official layouts, never edit the original.
- **Bespoke:** disabled. The Artist does not create a substitute theme.

If Slides is down: dry-run only (`rendering_pending`). Gamma PPTX is an optional confirmed fallback, not a silent substitute.

## Error policy

| Failure | Behavior |
|---|---|
| Claude down | Block. No silent model swap |
| Drive down | Dry-run narrative; no save claims |
| Slides down | JSON + Markdown; `rendering_pending` |
| PPTX fail | Keep Slides; report PDF independently |
| Missing data | Focused question or labeled assumptions |
| Missing template | Default premium / bespoke / upload / blueprint-only |

## Governance

Writes and shares require explicit approval. Artifacts are private by default. Templates are copied. Confidentiality labels are required. Each generation gets an audit record. API keys never leave Gumloop credential storage.
