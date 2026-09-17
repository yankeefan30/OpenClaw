---
name: meeting-infographic
description: Turn raw meeting notes, transcripts, message threads, or lifelog recordings into a single-page portrait infographic (self-contained HTML) with a timeline of events, an action-item section, and a high-level summary. ALWAYS use when the user asks for an infographic, a one-pager, a visual recap, a recap graphic, or a visual summary of a call or meeting, or says "turn this into an infographic," "make this board-ready," "give me a one-page visual," or "build a recap graphic from this transcript/lifelog/thread." Trigger even without the word "infographic" when the user pastes or references a transcript, meeting notes, a message thread, or a lifelog and wants a single visual page or poster-style summary. Owns the single-page visual artifact — a multi-slide deck belongs to tilak-powerpoint or executive-deck-builder, a formal Word minutes document belongs to docx, a recurring metrics deck belongs to monthly-ops-metrics or okr-review-deck. Use this instead when the deliverable is one page, one file, read at a glance.
---

# Meeting infographic

Converts raw source material — a meeting transcript, an AI meeting-notes export (Wispr Flow, Plaud, Otter, etc.), a message thread, or a lifelog recording (Limitless-style ambient transcript) — into one self-contained HTML file: a portrait, one-page infographic built to be looked at, not scrolled through. The reader should get the whole story in under thirty seconds and be able to drill into any item if they want more.

The output is a single `.html` file with all CSS and icons inline. No external fonts, no CDN calls, no build step. It opens in any browser and prints to one PDF page.

## Before building anything

Read `assets/template.html` in full. It is not sample copy to browse — it is the working reference: every component (header, summary strip, timeline, action cards, status bar, decision/open-question blocks, footer) is already built, styled, and commented. Build every infographic by copying that file and replacing its placeholder content, not by generating markup from scratch. This is what keeps every infographic this skill produces looking like it came from the same shop.

## Step 1: identify the source type

The extraction rules differ by source because the raw material carries different signal:

- **Meeting notes / AI transcript export** (Wispr Flow, Plaud, Otter, Fireflies). Usually already has attendees, start/end time, and often a pre-extracted "next steps" or "action items" list. Prefer that pre-extracted list over re-deriving it from the transcript — it was built by a model that heard the whole conversation; re-deriving from a summary loses information.
- **Message thread** (Slack, iMessage, email chain, Little Bird search results). No formal agenda. Timeline events are the moments the thread's direction changed — a decision, a new ask, a blocker raised. Action items are commitments phrased as a first-person promise ("I'll have this by Friday") or a direct ask of a named person ("@Sam can you own the vendor call").
- **Lifelog** (Limitless or similar all-day ambient capture). May span more than one conversation or location. Look for a real topic or setting break before treating it as more than one timeline segment — don't invent segment boundaries that aren't there. Attendees are only as reliable as the underlying speaker labels; if the source doesn't label speakers, leave the attendee row off rather than guessing names from context.
- **Plain notes with no timestamps.** No literal times. Use ordered position instead of clock time in the timeline (see Step 4).

If the source is ambiguous or mixes types, ask which frame to use rather than guessing — the choice changes what counts as an "event" versus a "task."

## Step 2: extract, don't invent

Pull the raw material into this structure before writing a line of HTML. This is the contract between source and output — everything on the page should trace back to something in it.

```
meta:
  title              # meeting/thread/session name; if the source doesn't name it, describe it plainly ("Weekly sync, Sept 9") rather than inventing a title
  date, time_range    # omit time_range if the source gives no clock times
  source_type         # meeting | messages | lifelog | notes
  attendees[]          # {name, initials} — omit the whole block if the source doesn't name participants
summary:
  headline            # one line, what this was and why it happened
  takeaways[]          # 3-5 bullets max — the things a reader needs even if they read nothing else
timeline[]:
  - time               # clock time if the source has one, else null
    label              # short, e.g. "Vendor pricing raised"
    detail             # one sentence
    kind               # discussion | decision | presentation | break — used to pick the icon
decisions[]:           # optional — only if the source contains an actual decision, not a discussion
  - text, made_by
actions[]:
  - task
    owner              # name, or "Unassigned" if the source doesn't name one — never guess an owner
    due                # date, or "No date set"
    status             # done | in_progress | blocked | open — default to "open" if the source states nothing; note this default once, don't imply completion that wasn't stated
open_questions[]:      # optional — only if something was genuinely left unresolved
  - text
```

Every array is allowed to be empty. `decisions` and `open_questions` are the two blocks that most often should be — render them only when the source actually contains a decision or an unresolved question. An empty "Decisions" box on the page is worse than no box; it implies nothing was decided when the truer read is that this wasn't a decision meeting.

Do not assign a status, priority, or owner the source doesn't state. Where you have to make a judgment call — grouping two related asks into one action item, inferring "blocked" from tone rather than an explicit statement — that's a legitimate editorial choice, but keep it conservative and default to the plainer reading. If the source is genuinely silent on status, the card should read "Open" in neutral gray, not green or red.

## Step 3: the visual system

The template encodes this; the reasoning is here so you don't have to guess when content forces a judgment call.

**Palette.** Cool white paper (`#FFFFFF`) with a light slate panel tone (`#F4F5F7`), near-navy ink (`#121826`) for text, a single working accent — deep blue (`#1D4ED8`) — for the rail, header band, and links. Status color is functional, not decorative: slate for open, amber for in progress, green for done, red for blocked. Four colors doing real work beats a palette chosen to look designed.

**Type.** Two families. A serif (`ui-serif` / Georgia stack) for the title only — it reads as an institutional, board-facing register rather than a marketing one. Everything else in a system sans (`-apple-system` / Segoe UI / Helvetica Neue stack) for density and legibility at small sizes. Clock times, dates, and any case or ticket IDs render in a monospace stack — that's a data-precision convention, not a design flourish, so don't extend it to labels or headings.

**Icons.** A small inline SVG sprite lives in the template's `<defs>` block — calendar, clock, checkmark, flag, person, people, alert-triangle, chevron, document, target, message, mic, link. Reference them with `<use href="#icon-name">`. Don't pull in an icon font or a CDN; the whole point of a single-file artifact is that it still works with no network.

**Cards and blocks.** Each action card carries a 4px left-edge bar colored by status — that's the differentiator, not a uniform drop shadow on every box. Corner radius is one value (`10px`) throughout. Section headers are sentence case, not tracked-out capitals — capitals-as-eyebrow is one of the most common tells of a templated page, and it isn't information here, just decoration.

**Progress bars mean something.** The one progress element on the page is the action-status distribution bar at the top of the Action items section: a single horizontal bar segmented by actual count of open / in-progress / done / blocked items. Build it from real counts. Never show a "percent complete" figure unless the source states individual items are done — a fabricated completion percentage on a document that will sit in front of a board is the failure mode this rule exists to prevent.

## Step 4: lay out the page

Fixed canvas: `8.5in × 11in` (US Letter portrait, `816 × 1056` CSS px at 96dpi). `@page { size: letter portrait; margin: 0; }` in a print block so opening the file and printing produces one clean page. Top to bottom, single column:

1. Header band (deep navy) — title, one-line meta (date, source type icon, attendee count), attendee initials row if the source names participants.
2. Summary strip — headline sentence, 3-5 takeaway bullets, optionally 2-3 compact stat chips (duration, decision count, action count) if those numbers are real and worth the reader's eye going there first.
3. Timeline — a vertical rail on the left, one dot and connector per event, card to the right with time (if known), label, one-line detail, and a kind icon. If the source has no clock times, replace the time column with plain ordinal position (First, Then, Finally, or 1/2/3) — that's a real sequence, so numbering it is earned, not decorative.
4. Decisions block — only if `decisions[]` is non-empty.
5. Action items — status-distribution bar, then cards: task, owner chip, due date, status chip.
6. Open questions — only if `open_questions[]` is non-empty. Keep it short; this is a flag, not a discussion.
7. Footer — one line: source description, generation date, and a plain confidentiality/handling note if the content warrants one. Don't editorialize here.

**When content doesn't fit.** The template ships two density variants: default (`<div class="page">`) and compact (`<div class="page compact">`, already defined in the CSS — just add the class). Tested against realistic content, not guessed: default density holds about 5 timeline events and 6 action items (two-column grid) alongside a Decisions and an Open questions block, exactly at one page. Compact tightens every block, not just the action grid, and holds about 7 timeline events and 9 action items (three-column grid) at the same one page. If your build environment can render HTML — a headless browser, a screenshot tool — render the finished page and check its actual height against `1056` CSS px (11in at 96dpi) rather than trusting these reference counts blind; they'll drift as soon as item text runs long or short. If you can't render, use the counts above as the practical ceiling. Past it, don't keep shrinking text — keep the most recent or most material items and add a single closing line, "+4 more action items in the full notes," rather than letting the page overflow or run to a second sheet. A one-pager that quietly drops detail and says so is more useful than one that either overflows or lies about how much happened.

## Step 5: build, check, deliver

1. Copy `assets/template.html` to the output path. Replace placeholder content block by block, following Step 2's structure. Delete any optional block (`decisions`, `open_questions`, stat chips) that has nothing real to put in it — don't leave it as an empty shell.
2. Self-check before saving:
   - Every name, date, and time on the page traces to the source. Nothing invented.
   - No status or priority implied that the source didn't state.
   - Section headers are sentence case; no tracked-out capitals.
   - One color family for status, used consistently — a task isn't red in one place and gray in another for the same fact.
   - The page is one canvas: if you have a way to render HTML (a headless browser, a screenshot tool), load the file and check the `.page` element's rendered height against `1056` CSS px — that's what "one page" actually means here, not a visual guess. If you don't have a renderer available, sanity-check the item counts against the density reference in Step 4 instead.
3. Save to `/mnt/user-data/outputs/<descriptive-name>.html` and present it with `present_files`. Tell the user, once, that opening it and using the browser's print dialog produces a clean single-page PDF for a board packet — don't repeat that instruction on every run.

## What this skill is not for

Not a replacement for full meeting minutes — the summary block is an abstract, not a transcript. If the user wants the complete record, that's a docx deliverable, not this one. Not a multi-page report: if the content genuinely needs more than one page to represent honestly, say so and suggest executive-deck-builder or docx instead of forcing it onto one canvas.
