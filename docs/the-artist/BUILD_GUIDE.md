# The Artist — Build guide

## 1. Create the agent

Gumloop → Agents → create **The Artist**.

- Model: `gummies_smartest`
- Description: Turn complex thinking into decisive executive stories.
- System prompt: paste `SYSTEM_PROMPT.md`
- Attach the nine `artist-*` skills
- Tool discovery: auto
- Attach connectors listed in `ADMIN.md`

## 2. Upload skills

Each directory under `skills/` is a package (`SKILL.md` + `references/`).

Skills → Upload Files → zip or `SKILL.md`. Names must be lowercase-hyphen.

Or, after files are in Gumloop workspace storage, MCP `create_skill` with those file names.

## 3. Wire the stages

There are no canvas wires. Router order is in the system prompt:

0 setup → 1–3 intake/brief → 4 storyline → (Mode 1 stop) → 5 slides → 6 design → 8 editor → 9 package → 7 render only after approval.

## 4. First-run

1. Open [The Artist](https://www.gumloop.com/agents/CL4wbckwSbtrUJB6de42CY) and start a chat.
2. Say: “Run The Artist setup and connector check.”
3. Connect Google Slides if the report says unauthenticated.
4. Approve a Drive parent folder if you want the standard tree.
5. Confirm the activation copy.
6. Run a Mode 1 outline on a real brief before approving a render.

## 5. Test prompts

Outline / dry-run:

```text
Create a 12-slide CEO and board deck requesting approval for a three-year
cybersecurity transformation. Audience: CEO, CFO, Board Risk Committee, CIO,
business-unit presidents. Decision: approve a $42M investment over three years.
Do not invent loss-reduction figures. Use labeled assumptions where evidence
is missing. Output Mode 2 plus PowerPoint-ready JSON. Do not render or write
to Drive until I confirm.
```

Setup:

```text
Run The Artist setup and connector check. Do not create Drive folders.
```
