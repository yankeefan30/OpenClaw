# Colleague Zone read-only status adapter

This module implements `rico.cvs-colleague-zone-status-adapter/v2` for the ISTS
workflow. It uses exactly one dedicated Playwright persistent profile beneath
the private ISTS state directory. It never imports a Polar, Safari, Chrome, or
other everyday browser profile and never calls Playwright cookie or
`storageState` APIs.

The daemon path is headless and read-only:

- only `GET`, `HEAD`, and `OPTIONS` requests are allowed;
- URLs associated with creating or regenerating AI Insights are blocked;
- the worker navigates directly to exact reviewed overview/detail URLs and
  never clicks a page action;
- page bodies are held transiently for deterministic parsing and never logged;
- screenshots, HTML dumps, request bodies, cookies, input values, passwords,
  one-time codes, and browser storage are never captured or returned.

## Interactive reauthentication

An expired session returns `colleague_zone_reauth_required`. The operator then
runs the bundled `scripts/reauth.mjs` command. It opens the same dedicated
profile in a visible browser. The person completes credentials and MFA directly
in the browser; the script does not type, inspect, log, or receive either. The
browser closes as soon as the authenticated Current Status page is detected.
All visible AI Insights actions and matching generation endpoints remain
blocked during this window.

```bash
node scripts/reauth.mjs --status
node scripts/reauth.mjs
```

Playwright Core and a compatible Chromium executable must be available. The
adapter first uses a separately installed Chrome, Edge, Chromium, or Brave
binary, then an official Playwright Chromium installation. If neither exists,
preflight fails closed with `colleague_zone_browser_executable_unavailable`.
It never falls back to controlling Polar or another signed-in personal browser.

On the reviewed Apple Silicon OpenClaw installation, OpenClaw supplies
`playwright-core@1.61.1`. Its matching full, headful-capable Chromium can be
installed without the unnecessary headless-shell download using:

```bash
/opt/homebrew/bin/node /opt/homebrew/lib/node_modules/openclaw/node_modules/playwright-core/cli.js install --no-shell chromium
```

That revision is resolved through the same Playwright Core package's
`chromium.executablePath()`. The executable cache is not an authenticated
profile; all authenticated state remains in the adapter's dedicated private
profile directory.

## Offline verification

From the parent `ISTSIncidentWorkflow` directory:

```bash
npm run check
npm test
```

Tests use static fictional DOM snapshots and injected fake readers. They never
open a browser, access CVS Health, read credentials, or generate AI Insights.
