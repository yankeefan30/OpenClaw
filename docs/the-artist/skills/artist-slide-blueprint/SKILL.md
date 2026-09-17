---
name: artist-slide-blueprint
description: >
  Slide-by-slide PowerPoint and Google Slides blueprint generator for The Artist.
  ALWAYS use when producing full blueprints, answer-first titles, slide types,
  speaker notes, or Mode 2 output. One slide, one message. Never invent data.
  Never render files.
icon: layout-template
color: Blue
---

# Slide Architect

Module 5. High-capability Claude. Inputs: `deck_brief` + `storyline` + length.

## Rules

- Title is a conclusion, 8–18 words. Bad: “Cloud Migration.” Strong: “Completing the final 20% of migrations unlocks $18M in annual savings but requires a targeted modernization investment.”
- One primary message. Three unrelated conclusions → split or redesign.
- Body generally <45 words. Max 3–5 bullets. 8–14 words per bullet where possible.
- Speaker notes do not reprint on-slide copy.
- Every slide includes purpose, layout, visual, data required, sources, design guidance, and quality_check.
- Decision decks end with Decision and Next Steps.
- Honor prohibited claims and confidentiality.

## Slide-type library (pick; do not default to bullets)

1. **Executive summary** — headline, three proof points, decision box, requested action.
2. **Why now** — trend, event timeline, before/after, burning-platform map, exposure callout.
3. **Performance bridge / waterfall** — start, drivers, end; +/- color semantics; one takeaway.
4. **Annotated trend** — inflection point; direct labels; decision-relevant annotation only.
5. **Option comparison** — 4–6 criteria; recommended path highlighted; no false precision.
6. **2x2 / prioritization** — labeled axes; ≤10–15 items; recommended action zone.
7. **Operating model / process** — sequence, handoffs, roles, controls; few boxes.
8. **Roadmap** — phases, milestones, dependencies, gates, owners, measures, critical path.
9. **Risk heat map** — likelihood/impact; inherent vs residual; appetite line; named actions.
10. **Architecture / ecosystem** — layers, flows, trust zones; decision-relevant change only.
11. **So-what insight** — one large insight, one evidence visual, implication, action.
12. **Decision slide** — ask, recommended action, why now, investment, impact, risks/mitigations, owner, deadline.

Vary layouts. Do not repeat one grid on every slide.

## Audience translation

Board / CEO / president: what changed, why now, money, risk, alternatives, recommendation, tradeoffs, decision, next actions, measures, where intervention is needed. No status without implication.

Cyber / technology: resilience, trust, revenue protection, regulatory exposure, continuity, financial exposure, appetite, residual risk, control effectiveness, time-to-detect/recover, critical-service availability, investment tradeoffs.

Example: not “EDR coverage improved from 83% to 94%.” Prefer “Expanded endpoint coverage reduces unmonitored critical assets by 65%, but 420 legacy devices remain outside the target control baseline.” Only if those numbers exist in sources.

## Output

`slides[]` per `references/slides.schema.json`. If chart data is missing, keep the spec and mark series `[MISSING]`.

## Errors

| Condition | Action |
|---|---|
| Slide-count overrun | Move evidence to appendix; do not cram |
| Multi-message slide | Split or unify around one conclusion |
| Invented precision | Remove; label estimate or drop |
| Claude unavailable | Block |
