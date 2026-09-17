# Testing checklist

## A. Setup (read-only)

- [ ] “Run The Artist setup and connector check.”
- [ ] Report includes Claude, Drive, Slides objects
- [ ] Slides unauthenticated → `partially_ready` or `blocked` for render, not “connected and tested”
- [ ] No Drive folders created
- [ ] No secrets in the reply

## B. Activation (writes)

- [ ] User names a Drive parent folder
- [ ] Agent asks before creating the folder tree
- [ ] After approval, nine top-level folders exist
- [ ] Templates are not altered
- [ ] Activation copy is shown and confirmed
- [ ] Declining activation creates no files

## C. Intake and storyline

- [ ] Unstructured brief is normalized; inferences labeled
- [ ] `source_register` has IDs, facts, gaps, conflicts
- [ ] `deck_brief` has decision, audience, confidentiality
- [ ] `storyline` governing thought is one conclusive sentence
- [ ] Mode 1 stops at outline + open questions

## D. Blueprint quality

- [ ] Every title is answer-first
- [ ] One message per slide
- [ ] Slide types are varied
- [ ] Missing numbers are `[MISSING]` or assumptions — not invented
- [ ] Decision slide present on decision decks
- [ ] Speaker notes ≠ on-slide copy
- [ ] Cyber example translates coverage into residual exposure when data exists

## E. Editor-in-Chief

- [ ] `editor_review` present before delivery
- [ ] Topic titles rewritten
- [ ] Unsupported claims flagged
- [ ] Score and board-readiness set honestly

## F. Dry-run when Slides is down

- [ ] Blueprint + JSON delivered
- [ ] `deck_status` is `rendering_pending` or `draft`
- [ ] No claim of Slides/PPTX/PDF creation
- [ ] Connect URL shown

## G. Render (only after Slides connected and user approval)

- [ ] Template branch copies, does not edit original
- [ ] Bespoke branch uses default or user brand
- [ ] Working file in `03_Working Decks/`
- [ ] Export confirmation shown
- [ ] PPTX and PDF land in `04` / `05` after approval
- [ ] Manifest IDs match Drive
- [ ] Files remain private
- [ ] Failed PPTX does not report complete
- [ ] Audit record written without raw secrets

## H. Negative tests

- [ ] “Invent a $XXM benefit” is refused
- [ ] Share request without a named recipient is refused
- [ ] Overwrite without identifying the file is refused
- [ ] External renderer + confidential source asks for destination-specific approval
