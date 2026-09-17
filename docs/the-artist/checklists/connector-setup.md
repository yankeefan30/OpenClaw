# Connector setup checklist

Complete before enabling rendering.

## Claude / Anthropic

- [ ] Gumloop agent model is a Claude-class high-capability model (`gummies_smartest` or explicit Claude)
- [ ] Organization Anthropic / Gumloop model credits or BYOK configured in **Gumloop credentials**, not in a prompt
- [ ] No API key appears in system prompt, skills, Drive files, or chat
- [ ] Lightweight test: agent completes a one-sentence reply
- [ ] Optional cheaper model documented for a future extraction flow — not used silently

**Permissions:** Gumloop model access. If BYOK, Anthropic API key in connector storage only.

**Connect / credentials:** Gumloop Settings → Profile → Credentials / model providers.

## Google Drive

- [ ] User selected the Google account (do not auto-pick if several exist)
- [ ] Drive connector shows connected: [gdrive apps](https://gumloop.com/settings/profile/apps?server=gdrive)
- [ ] Read test: `search` or `list_files` returns without 401
- [ ] User approved a parent folder
- [ ] After approval only: The Artist folder tree created
- [ ] Template folder ID and output folder ID saved
- [ ] Sharing remains private (no `anyone` links)

**Permissions:** Drive file read/write on the signed-in account. Delegated user access only.

Required scopes in practice: list/search files, create folders, copy files, upload/download, export. Sharing scope should remain unused unless the user approves a named share.

## Google Slides

- [ ] User authenticates Slides: [gslides apps](https://gumloop.com/settings/profile/apps?server=gslides)
- [ ] Tool list is non-empty (not `unauthenticated`)
- [ ] Create / edit / template-copy / PPTX export / PDF export capability recorded after a real test — do not create a deck solely as a test unless the user approves a disposable test file
- [ ] Slides attached on The Artist agent (not only in account settings)

**Permissions:** Slides create/edit on the signed-in account; Drive access to store and export.

## Agent assignment

- [ ] Drive, Slides, Excel/Sheets, Word attached to **The Artist**
- [ ] Destructive Drive tools restricted
- [ ] Skills attached
- [ ] Activation confirmation accepted
- [ ] Agent marked active for rendering only after `safe_to_activate=true`

## Current workspace snapshot (live check 2026-09-17)

Read-only session on [The Artist](https://www.gumloop.com/agents/CL4wbckwSbtrUJB6de42CY). No folders or decks created.

| Connector | Observed status | Action |
|---|---|---|
| Claude (`gummies_smartest`) | Connected and tested (live reasoning) | None |
| Google Drive | Connected and tested as `alan.a.rosa@gmail.com` | Approve a parent folder when you want the tree created |
| Google Slides | Connected and tested via agent `search_presentations` (Cursor catalog list may still show unauthenticated) | PPTX/PDF export still untested; first render needs approval |
| Gamma | Connected | Optional PPTX fallback after separate confirmation |
| Google Sheets | Unauthenticated in catalog | Connect if Sheets sources are required: [gsheets](https://gumloop.com/settings/profile/apps?server=gsheets) |

`overall_status`: ready for narrative work. **Not activated.** Parent folder not selected. Rendering gated on your approval.
