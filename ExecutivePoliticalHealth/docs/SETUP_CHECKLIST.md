# Setup checklist

## 1. Notion integration

- [ ] Create **Internal Integration** at https://www.notion.so/my-integrations
- [ ] Capabilities: Read content, Update content, Insert content
- [ ] Copy the **Internal Integration Secret** → `NOTION_TOKEN`
- [ ] Do **not** commit the secret

## 2. Share workspace objects

Share **each** of the following with the integration (Connections → invite integration):

- [ ] Page: Executive Political Health
- [ ] Daily Assessments
- [ ] Strategic Relationships
- [ ] Relationship Daily Assessments
- [ ] Dimension Scores
- [ ] Interactions
- [ ] Evidence Ledger
- [ ] Risks & Opportunities
- [ ] Actions
- [ ] Analysis Runs

IDs are in `docs/notion-ids.json` and `.env.example`.

## 3. Local / runtime config

```sh
cd ExecutivePoliticalHealth
cp .env.example .env
# edit NOTION_TOKEN
npm install
npm test
npm run validate -- --file fixtures/sample-daily-payload.json
npm run import:dry-run -- --file fixtures/sample-daily-payload.json
```

## 4. First live write

```sh
npm run import -- --file fixtures/sample-daily-payload.json
```

- [ ] Daily Assessment row appears for the analysis date
- [ ] Analysis Run ends in Needs Review or Succeeded
- [ ] Tier 1 person Sam shows health < 60 and review flag
- [ ] Open P0/P1 Actions linked view shows suggested actions
- [ ] Evidence Audit Trail shows six evidence rows
- [ ] Human Context Notes on a person remain intact if you typed them before re-import

## 5. Schedule

- [ ] Place daily JSON at a stable path before 05:00 America/New_York
- [ ] Cron / scheduler invokes `src/cli.ts --file …`
- [ ] Logs land in a private log sink (importer already redacts secrets)

## 6. Executive usability

- [ ] Pin the dashboard page in Notion Private sidebar
- [ ] Confirm Weekly Review child page is visible
- [ ] Walk the Legend section with the executive once
- [ ] Agree that raw transcripts stay outside Notion
