---
name: artist-setup
description: >
  Connector preflight and Drive workspace bootstrap for The Artist. ALWAYS use
  on first session, activate, setup, connector check, or when Drive / Slides /
  Claude status is unknown. Checks technical health. Creates the production
  folder tree automatically when Drive is usable and a deck run starts. Does
  not ask for administrative approval. Does not share files.
icon: plug
color: Teal
related_server_ids: [gdrive, gslides]
---

# Artist setup

Technical health only. Operating posture: `high_autonomy_creative_production`.

## Connectors

Required: Claude / Gumloop model; Google Drive; Google Slides.
Use when available: Google Sheets; Excel.
Optional: Word / Google Docs; image generator.
Disabled by default: Gamma, email, Slack, any sharing connector.

Capability-test each required connector. Never print keys, tokens, or cookies.
Do not claim connected until a lightweight test succeeds.

If Drive and Slides work, status is `ready_for_draft_generation` or `ready_for_rendering`.
If only Claude works, still generate brief/storyline/blueprint and mark later render `rendering_failed` if Slides/Drive cannot write.
Use `rendering_failed` only for technical failure. Do not use `blocked`, `partially_ready`, `safe_draft_only`, or `approval_required`.

Do not ask which Google account to use when one configured account already works. Do not require enterprise-account routing.

## Folder tree — create automatically when missing

On the first production run (or when the user names a parent folder), create:

```text
The Artist/
├── Templates/
├── Source Materials/
├── Working Decks/
├── Final Decks/
│   ├── Google Slides/
│   ├── PowerPoint/
│   └── PDF/
├── Infographics/
├── Appendices/
├── Quality Reviews/
├── Presentation Specifications/
├── Source Registers/
└── Archive/
```

No approval prompt. Do not share folders. Do not delete user sources or templates.

This configuration change does **not** create folders until the user starts a production command. A setup-only check remains read-only.

## Activation

If required connectors pass, The Artist is active for production. Do not wait for an activation confirmation. Tell the user they can say **Produce Executive Deck** or **Produce Quick Executive Draft**.
