# The Artist — End-user guide

The Artist turns a raw executive request and source material into a board-ready story, a slide-by-slide blueprint, and — after you approve — a Google Slides deck with PowerPoint and PDF exports.

**Tagline:** Turn complex thinking into decisive executive stories.

## What to expect

You will get a visual argument, not a memo pasted onto slides.

- Answer-first titles (the conclusion is in the title).
- One message per slide.
- Charts and diagrams that earn their place.
- Facts separated from assumptions.
- A Decision and Next Steps slide on decision decks.
- An Editor-in-Chief review and board-readiness score.

## How to start a deck

In the Gumloop agent chat, include:

1. Deck title and objective
2. Audience (board, CEO, ELT, CFO, CISO, …)
3. Decision requested
4. Topic / business problem
5. Sources (paste, upload, or a Drive link)
6. Length or deck type (3-slide brief, 5–7 decision, 8–12 ELT, 12–18 board, 18–30 strategy, cyber, transformation, operating review, redesign, or custom)
7. Output mode (outline, full blueprint, JSON, redesign, or render after approval)
8. Confidentiality label

Every deck uses the **CVS Health 2025 Enterprise Template**. The Artist copies it; it never edits the original and never switches themes. Optional: presenter, tone, prohibited claims, whether you need speaker notes or an appendix.

To revise an existing deck from a conversation, attach the deck and say **Apply Lifelog Feedback** with the Limitless meeting, date, or topic. The Artist searches that lifelog and updates a new version of the file. It does not overwrite the original.

To turn a Limitless meeting into one-page notes, say **Produce Meeting Infographic** and name the lifelog. The Artist follows the `meeting-infographic` skill and saves a portrait HTML file you can print to PDF.

If you dump an unstructured brief, The Artist will infer fields and tell you what it inferred.

## First-run activation

On first use, ask: **“Run The Artist setup and connector check.”**

You will see a readiness report for Claude, Google Drive, and Google Slides. Rendering stays off until those pass and you confirm activation. Folder creation in Drive happens only if you approve a parent folder.

## What The Artist will ask you to approve

Status checks and reading selected sources do not need approval.

You will be asked before it:

- Creates the The Artist folder tree in Drive
- Activates rendering
- Creates a Google Slides deck
- Writes files to Drive
- Exports PPTX or PDF
- Shares a file
- Changes or overwrites a template or existing deck
- Sends a deck to email or Slack
- Deletes working files in no-retention mode

## If Google Slides is not connected

You still get the brief, storyline, blueprint, speaker notes, and JSON. The package is marked `rendering_pending`. Connect Slides at [gumloop.com/settings/profile/apps?server=gslides](https://gumloop.com/settings/profile/apps?server=gslides), then ask to render.

## What The Artist will not do

- Invent metrics, quotes, or financial benefits
- Share files by default
- Edit the CVS Health 2025 Enterprise Template in place or replace it with another theme
- Put secrets in filenames or chat
- Substitute a one-page infographic for a requested multi-slide deck
