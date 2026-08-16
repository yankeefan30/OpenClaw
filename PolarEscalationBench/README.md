# Polar/COS escalation bench

This is the local, fixed-path safety layer used by Polar's existing Grok Bot
routine, **Rico stuck-question escalation**. The routine remains the scheduler
and research agent. An owner-only launch service dispatches requests and commits
results. The service does not call a model, open an application, send a message,
or alter Grok Bot's existing autonomy.

Managed paths are fixed to:

- `/Users/alan/Documents/Codex/rico-escalate/INBOX.md`
- `/Users/alan/Documents/Codex/rico-escalate/OUTBOX.md`
- `/Users/alan/Documents/Codex/rico-escalate/state.json`
- `/Users/alan/Documents/Codex/rico-escalate/DISPATCH.json`
- `/Users/alan/Documents/Codex/rico-escalate/RESULT.json`
- `/Users/alan/Documents/Codex/rico-escalate/MAILBOX-STATUS.json`

The directory must be a real owner-only directory (`0700`). Managed files must
be regular, owner-owned, single-link files (`0600`). Symlinks, hard links,
ownership drift, unexpected modes, oversized files, duplicate request IDs,
modified claimed requests, stale claim tokens, and malformed records fail
closed.

The launch service is `ai.polar.rico-escalation-mailbox`, installed at
`/Users/alan/Library/LaunchAgents/ai.polar.rico-escalation-mailbox.plist`. It
runs `mailbox.js watch`, reacts to inbox/result changes, and also retries every
30 seconds. Launchd restarts it after a crash.

## Routine protocol

The Grok Bot routine uses native file tools. It reads only `DISPATCH.json`. An
idle status is a no-op. A claimed status contains an exact request ID, claim
token, bounded request, and untrusted-content marker. Polar researches under
its existing authority and may consult COS with only the sanitized request.

When `request.resultContract` is `imt-current-status/v1`, the dispatch also
contains a trusted top-level `required_result_contract` object and appends its
requirements to the trusted `instruction` string. Question text remains
untrusted data. For that request only, Polar must return all four structured
fields shown below; a legacy or partial result is rejected and remains
correctable in `RESULT.json`. Unmarked generic requests retain legacy
compatibility.

Before returning a result, the routine re-reads the dispatch and requires the
same request ID and claim token. It overwrites only the existing `RESULT.json`
with this shape:

```json
{
  "version": 1,
  "status": "ready",
  "requestId": "<exact dispatch.requestId>",
  "claimToken": "<exact dispatch.claimToken>",
  "confidence": "high",
  "answer": "Compiled answer",
  "evidence": ["Source or evidence pointer — supported claim"],
  "unresolvedLimits": ["none"],
  "resultContractVersion": 1,
  "observedAt": "2026-08-15T23:25:00.000Z",
  "sourceClass": "public_authoritative",
  "publicCitations": [
    {
      "title": "Public source title",
      "url": "https://www.cvshealth.com/news/company-news/service-update.html",
      "publishedAt": null
    }
  ]
}
```

Allowed research-worker `sourceClass` values are `public_authoritative`,
`public_secondary`, and `unverified`. Polar must never return `official_live`;
only a separately trusted host attestation could establish that state, and no
such attestation is part of this contract. If no current status can be established,
return `sourceClass: "unverified"`, `observedAt: null`, and
`publicCitations: []`; do not fabricate metadata. Citations must be public HTTPS
URLs without credentials, sensitive query parameters, local/private/reserved
hosts, private ServiceNow tenant URLs, or private-system attribution. Answers
and citation titles must not contain provider/handoff names, personal phone or
email data, credentials, internal IDs/paths, private source attribution, role
envelopes, `@rico`, or action-shaped instructions. Ordinary descriptive public
ServiceNow and Moveworks articles remain allowed.

Fresh high-confidence public classes can be shown only with Rico's fixed
public-context caveat; they can never be rendered as the current official IMT
view. An `official_live` self-attestation, low-
confidence, stale, future-dated, unverified, legacy, or malformed results
render only the exact neutral proof.

Grok Bot's native writer recreates its target as owner-owned `0644`. Because the
handoff directory is already owner-only `0700`, the file is not reachable by
other users. The resident service watches the result, verifies the exact path,
owner, regular-file type, single link, real path, and size, then changes that
same opened inode to `0600` before reading any bytes. Every other mode fails
closed. The result is then validated, appended atomically to the outbox, and
deduplicated. A crash leaves a bounded lease; an interrupted outbox/state update
is repaired without duplicating the answer.

The digest runner remains an owner-only diagnostic and manual recovery path. It
accepts only `next`, `complete`, `renew`, or `defer`, verifies the helper hashes,
and never puts answer content in argv. Grok Bot currently reports
`exec_unbound` for that executable binding, so the live routine does not depend
on it.

## Bounds and content policy

- Inbox/outbox: 4 MiB each; state: 512 KiB.
- One request/result record: 16 KiB UTF-8.
- Shared-audience requests must carry Rico's 64-hex
  `audience_scope_sha256` binding; it is validated but is not repeated in the
  outbox or exposed to the research prompt.
- Question: 4,000 characters; tried: 6 items of 500; done: 1,200.
- Answer: 10,000 characters; evidence: 12 items of 1,000; unresolved limits:
  8 items of 800. The combined result must still fit the 16 KiB record cap.
- No credentials, tokens, Keychain material, phone numbers, role-prefixed
  prompt injection, or "ignore previous instructions" payloads are accepted
  in results.
- Request content is never executed. Links, commands, and instructions inside
  a question are treated only as quoted research material.

Run offline QA with `npm run check`, `npm test`, and `npm run selftest`.
