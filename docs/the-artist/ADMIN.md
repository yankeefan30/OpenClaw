# The Artist — Admin README

Gumloop cannot author a visual node graph over MCP. Production The Artist is an **agent + modular skills + JSON contracts + connector preflight**. The skills are the workflow modules.

## Created modules

| Module | Skill / asset | Role |
|---|---|---|
| 0 Setup and activation | `artist-setup` | Connector health, folder approval, activation copy |
| Connector readiness | same | `artist_readiness_report` |
| 1 Presentation intake | `artist-intake` | Input contract |
| 2 Source ingestion | `artist-intake` | `source_register` |
| 3 Intake Strategist | `artist-intake` + `prompts/intake-strategist.md` | `deck_brief` |
| 4 Storyline Architect | `artist-storyline` + `prompts/storyline-architect.md` | `storyline` |
| 5 Slide Architect | `artist-slide-blueprint` + `prompts/slide-architect.md` | `slides[]` |
| 6 Design Director | `artist-visual-system` + `prompts/design-director.md` | Theme and charts |
| 7a Template render | `artist-renderer` Branch A | Copy template, populate |
| 7b Bespoke render | `artist-renderer` Branch B | New Slides deck |
| Drive artifacts | `artist-renderer` | Folder placement |
| PPTX/PDF export | `artist-renderer` | After export approval |
| 8 Editor-in-Chief | `artist-editor-in-chief` + `prompts/editor-in-chief.md` | Review + revise |
| 9 Output package | `artist-output-package` | Modes 1–4 + manifest |
| Audit record | `artist-output-package` | `audit_record` |
| Error / fallback | all skills + system prompt | Dry-run vs block |
| Prompt templates | `artist-templates` | Board / strategy / cyber / redesign |

Schemas live in `docs/the-artist/schemas/`. Primary system prompt: `SYSTEM_PROMPT.md` and `prompts/primary-system-prompt.md`.

Live agent: [The Artist](https://www.gumloop.com/agents/CL4wbckwSbtrUJB6de42CY) (`CL4wbckwSbtrUJB6de42CY`)

Canonical skill packages are in this repo. Live Gumloop skill IDs (attached):

| Skill | ID |
|---|---|
| `artist-setup` | `55UFjp7UFuuVVDpwVWnFcG` |
| `artist-intake` | `CfRxc3pKKbtPMYzJvUguDx` |
| `artist-storyline` | `U7XeicgYMXU6nUm6vf4XHz` |
| `artist-slide-blueprint` | `HaaSsEJ5omVAbSLSTYsmD4` |
| `artist-visual-system` | `Cx34VPQ9brRi6uUekmmmZv` |
| `artist-editor-in-chief` | `iJrz2VwmRrH9YhduYGd26Q` |
| `artist-renderer` | `EEJTVe3Lz5gTySbwNsK8bi` |
| `artist-output-package` | `JpV8DJvaHAEWjuK64jjBc4` |
| `artist-templates` | `ZJhSh7asgq7GEJoUGQG9kG` |

If a live skill still shows a scaffold description, upload the matching `docs/the-artist/skills/<name>/SKILL.md` via Gumloop Skills → Upload Files.

## Agent configuration

| Field | Value |
|---|---|
| Name | The Artist |
| Agent ID | `CL4wbckwSbtrUJB6de42CY` |
| Model | `gummies_smartest` (Claude 5 Opus) — high-capability role |
| Cheaper model | Not a second live agent model. Reserved for a future flow split (classification / metadata only) |
| System prompt | `SYSTEM_PROMPT.md` |
| Tool discovery | auto |
| Skill creation | enabled |
| Default approval | off for reads; skills enforce write confirmation |

### Connectors to attach

| Server | Purpose | Restrict |
|---|---|---|
| `gdrive` | Templates, sources, outputs | `delete`, `trash_file`, `add_file_sharing_preference` |
| `gslides` | Primary canvas + export | none; user must authenticate |
| `excel`, `gsheets` | Numeric sources | no silent destructive writes |
| `word` | Narrative sources | create/write/delete unless asked |
| `gamma` | Optional confirmed PPTX fallback | confirm before generate |

Built-in: `web_search`, `web_fetch`, `human_input`, `interaction_search`.

**Never store an Anthropic API key in prompts, skills, repo, logs, or artifacts.** Use Gumloop credentials / org API-key settings (BYOK if permitted).

## Security

- Artifacts private by default
- Copy templates; never edit in place
- Confidentiality label on every deck
- Audit record per generation
- No-retention deletes only when requested and approved
- Do not put confidential source text in URLs or filenames

## Future flow split (optional)

If you later build a canvas flow: cheaper Claude node for classification/extraction; high-capability Claude nodes for storyline, slides, design, and Editor-in-Chief. The agent remains the production path.
