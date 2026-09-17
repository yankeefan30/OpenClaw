---
name: artist-lifelog-infographic
description: >
  Build one-page meeting infographic notes from a Limitless lifelog. ALWAYS use
  when the user says Produce Meeting Infographic, Build Infographic Notes from
  Lifelog, or asks for a one-page visual recap, poster, or meeting notes
  graphic from a Pendant recording, lifelog, transcript, or meeting minutes.
  Search Limitless, extract minutes without inventing facts, then follow the
  meeting-infographic skill and its HTML template. Not for multi-slide decks.
icon: layout
color: Blue
related_server_ids: [xat7jjj8vlu9gns6henqif, gdrive]
---

# Produce Meeting Infographic

Turns Limitless meeting minutes into one self-contained portrait HTML infographic.

This skill fetches the source. Then follow `meeting-infographic` exactly, including `assets/template.html`.

## Commands

```text
Produce Meeting Infographic
Build Infographic Notes from Lifelog
Turn this lifelog into a one-page visual
```

## Sequence

1. Search Limitless with `searchLifelogsWithTranscripts`. Use the user’s topic, date (`YYYY-MM-DD`), people, or meeting name. Optional `startTime` / `endTime` without timezone. `limit` 10.
2. If several lifelogs could match and the choice is not obvious, list them once. If one is clearly the meeting, use it.
3. Treat the transcript as a **lifelog** source in `meeting-infographic` Step 1. Do not invent attendees or segment breaks.
4. Extract the Step 2 contract (`meta`, `summary`, `timeline`, `decisions`, `actions`, `open_questions`). Every line traces to the lifelog. Owners stay Unassigned unless named. Status defaults to open. No fabricated completion percent.
5. Copy `meeting-infographic/assets/template.html` and replace placeholders. Delete empty Decisions / Open questions blocks.
6. Run the Final Pre-Board Quality Gate infographic review (`infographic_quality_review`). Fix hierarchy, density, and missing labels automatically. Do not invent facts to raise the score.
7. Save the HTML to `The Artist/Infographics/` as `YYYY-MM-DD_[Audience-or-Meeting]_infographic_vNN.html`. Version; do not overwrite.
8. Return the file, the lifelog used, headline, takeaways, action count, and quality status. Tell the user once that Print → PDF yields a one-page board packet.

## Do not

- Build a multi-slide deck. That is Produce Executive Deck.
- Apply deck feedback. That is Apply Lifelog Feedback.
- Guess speakers, owners, or decisions.
- Leave the Northbridge Health placeholder content in the file.

If Limitless is disconnected, say so and wait for a reconnect or a pasted transcript.
