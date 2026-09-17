---
name: artist-setup
description: >
  Setup, connector preflight, and activation for The Artist. ALWAYS use on first
  session, activate, setup, connector check, readiness, folder creation, or when
  Google Drive / Google Slides / Claude status is unknown. Runs health checks
  only. Creates Drive folders or marks the agent active only after explicit
  approval. Never writes files during a status check.
icon: shield-check
color: Teal
related_server_ids: [gdrive, gslides]
---

# Artist setup and connector verification

Run this module before any deck is rendered. Reads and capability tests do not need approval. Writes do.

## 1. Detect connectors

Test these three. Do not claim connected until a lightweight test succeeds. Never print API keys, tokens, or cookies.

### Claude / Anthropic

Capability test: the agent can complete this skill using the configured high-capability model (`gummies_smartest` / Claude 5 Opus, or the user-selected Claude model). If the model call fails, status is `unavailable` or `unauthorized`.

```json
{
  "connector": "anthropic_claude",
  "status": "connected | missing_credentials | unauthorized | unavailable",
  "model_available": "",
  "recommended_action": ""
}
```

Remediation if blocked: open Gumloop credentials / Anthropic connector settings. Do not place a key in chat. BYOK stays in Gumloop organization API-key settings.

### Google Drive

Capability test (read-only): `search` or `list_files` with `max_results`/`max_limit` of 1. If the user already named a parent folder, `list_contents` on that folder.

```json
{
  "connector": "google_drive",
  "status": "connected | missing_credentials | unauthorized | unavailable",
  "selected_account": "",
  "template_folder_access": true,
  "output_folder_access": true,
  "recommended_action": ""
}
```

If more than one Google account could apply, stop and ask which account to use. Do not guess.

Remediation: [Connect Google Drive](https://gumloop.com/settings/profile/apps?server=gdrive)

### Google Slides

Capability test: list tools on `gslides`. If the server is `unauthenticated` or returns no tools, status is `missing_credentials`. Do not create a presentation to test.

```json
{
  "connector": "google_slides",
  "status": "connected | missing_credentials | unauthorized | unavailable",
  "can_create_presentations": true,
  "can_edit_presentations": true,
  "can_use_templates": true,
  "can_export_pptx": true,
  "can_export_pdf": true,
  "recommended_action": ""
}
```

Remediation: [Connect Google Slides](https://gumloop.com/settings/profile/apps?server=gslides)

Also note Gamma (`gamma`) as an optional confirmed PPTX fallback. It is not a substitute for declaring Slides unauthenticated.

## 2. Status dashboard language

Use exactly one of: Connected and tested | Connected but missing required permission | Not connected | Authentication expired | Tool unavailable | Connected but not yet assigned to The Artist.

## 3. Readiness report

Return `artist_readiness_report` matching `references/readiness-report.schema.json`.

- `ready`: Claude + Drive + Slides all passed capability tests. `safe_to_activate` may be true only after the user confirms the activation copy.
- `partially_ready`: Claude works; Drive and/or Slides do not. Dry-run narrative work is allowed. Rendering is blocked.
- `blocked`: Claude is unavailable. Do not generate storylines or decks.

## 4. Folder structure (write — approval required)

Ask the user to choose or approve a Google Drive parent folder. After explicit approval only, create:

```text
The Artist/
├── 01_Templates/
│   ├── Board Decision Deck/
│   ├── Executive Strategy/
│   ├── Cybersecurity Risk Committee/
│   ├── Technology Transformation/
│   ├── Operating Review/
│   └── Blank Premium Default/
├── 02_Source Materials/
├── 03_Working Decks/
├── 04_Final PPTX/
├── 05_Final PDF/
├── 06_Appendices/
├── 07_Quality Reviews/
├── 08_JSON Specifications/
└── 09_Archive/
```

Use `gdrive.create_folder_subfolder`. Do not share folders. Do not create in root unless the user said root. Save folder IDs into the configuration record.

## 5. Activation confirmation

If all required connectors pass, show this copy in substance, then wait:

```text
The Artist is ready to activate.

It will use:
- Claude for executive reasoning, storytelling, and presentation QA.
- Google Drive to store approved templates, source files, working decks, and final artifacts.
- Google Slides to create and edit presentations.
- Google Slides export to produce editable PowerPoint (.pptx) and PDF versions.

By activating, you authorize The Artist to create new folders and files only inside the selected Google Drive workspace when you explicitly request a deck or approve a setup action. It will not share files externally or modify templates without separate approval.

Activate The Artist with this configuration?
```

Store the approved configuration only after confirmation:

- Claude model / model profile
- Google account
- Template folder ID
- Output folder ID
- Default branding
- Default confidentiality label
- Default presentation mode
- Activation state = active

If any required connector failed: show exact remediation. Do not create files or decks. Do not mark the agent active for rendering.

## 6. Error handling

| Condition | Action |
|---|---|
| Claude unavailable | `overall_status=blocked`. Preserve nothing that requires generation. Show credential remediation. |
| Drive unavailable | Allow later dry-run brief/storyline/blueprint. Do not save files. |
| Slides unavailable | Dry-run + `rendering_pending`. Show Slides connect URL. |
| Multiple Google accounts | Ask. Do not pick. |
| User declines activation | Save nothing. Remain inactive for writes. |
