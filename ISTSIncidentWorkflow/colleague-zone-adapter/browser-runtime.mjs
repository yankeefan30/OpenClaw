import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { COLLEAGUE_ZONE_SELECTORS } from './selectors.mjs';
import { isAuthenticatedOverview, parseActiveIncident, parseOverviewSnapshot } from './parser.mjs';

const NAVIGATION_TIMEOUT_MS = 30_000;
const DETAIL_TIMEOUT_MS = 20_000;
const SAFE_READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const BROWSER_EXECUTABLE_CANDIDATES = Object.freeze([
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
]);

export class ColleagueZoneBrowserReader {
  constructor({ profileDirectory, playwrightLoader = loadPlaywrightCore, executableResolver = resolveBrowserExecutable } = {}) {
    if (!path.isAbsolute(String(profileDirectory ?? ''))) throw coded('colleague_zone_profile_path_invalid');
    this.profileDirectory = path.normalize(profileDirectory);
    this.playwrightLoader = playwrightLoader;
    this.executableResolver = executableResolver;
    this.queue = Promise.resolve();
  }

  async preflight({ pageUrl }) {
    return this.#serialized(async () => {
      try {
        return await this.#withPersistentContext({ headless: true, readOnly: true }, async (context) => {
          const page = context.pages()[0] ?? await context.newPage();
          await navigate(page, pageUrl, NAVIGATION_TIMEOUT_MS);
          const auth = await authenticationSnapshot(page);
          return Object.freeze({
            runtimeState: 'ready',
            authenticationState: isAuthenticatedOverview(auth) ? 'ready' : 'reauth-required',
          });
        });
      } catch (error) {
        if (safeCode(error) === 'colleague_zone_reauth_required') {
          return Object.freeze({ runtimeState: 'ready', authenticationState: 'reauth-required' });
        }
        return Object.freeze({ runtimeState: 'unavailable', authenticationState: 'unavailable', errorCode: safeCode(error) });
      }
    });
  }

  async readActiveServiceStatus({ pageUrl, maxItems = 100, snapshotAt = new Date().toISOString() }) {
    return this.#serialized(async () => this.#withPersistentContext({ headless: true, readOnly: true }, async (context, guard) => {
      const overviewPage = context.pages()[0] ?? await context.newPage();
      await navigate(overviewPage, pageUrl, NAVIGATION_TIMEOUT_MS);
      if (!isAuthenticatedOverview(await authenticationSnapshot(overviewPage))) throw coded('colleague_zone_reauth_required');
      const candidates = parseOverviewSnapshot(await overviewSnapshot(overviewPage)).slice(0, Math.min(100, maxItems));
      const incidents = [];
      for (const candidate of candidates) {
        const page = await context.newPage();
        try {
          await navigate(page, candidate.detailUrl, DETAIL_TIMEOUT_MS);
          assertDetailPageURL(page.url(), candidate.detailUrl);
          const incident = parseActiveIncident(candidate, await detailSnapshot(page), { snapshotAt });
          if (incident) incidents.push(incident);
        } finally {
          await page.close().catch(() => {});
        }
      }
      return Object.freeze({
        incidents: Object.freeze(incidents),
        sideEffectsPerformed: false,
        aiInsightGenerationAttempted: false,
        blockedMutationRequests: guard.blockedMutationRequests,
      });
    }));
  }

  async interactiveReauth({ pageUrl, timeoutMs = 10 * 60_000, onState = () => {} }) {
    return this.#serialized(async () => this.#withPersistentContext({ headless: false, readOnly: false }, async (context) => {
      const page = context.pages()[0] ?? await context.newPage();
      await installAIInsightsInteractionBlock(page);
      await navigate(page, pageUrl, NAVIGATION_TIMEOUT_MS);
      onState('browser-open');
      const deadline = Date.now() + Math.max(60_000, Math.min(timeoutMs, 30 * 60_000));
      while (Date.now() < deadline) {
        if (isAuthenticatedOverview(await authenticationSnapshot(page))) {
          onState('authenticated');
          return Object.freeze({ authenticated: true });
        }
        await page.waitForTimeout(1_000);
      }
      throw coded('colleague_zone_interactive_reauth_timeout');
    }));
  }

  async #withPersistentContext({ headless, readOnly }, callback) {
    ensurePrivateProfileDirectory(this.profileDirectory);
    const playwright = await this.playwrightLoader();
    if (!playwright?.chromium?.launchPersistentContext) throw coded('colleague_zone_playwright_unavailable');
    const executablePath = await this.executableResolver(playwright.chromium);
    const options = {
      headless,
      acceptDownloads: false,
      viewport: { width: 1440, height: 1000 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      ...(executablePath ? { executablePath } : {}),
    };
    let context;
    try {
      context = await playwright.chromium.launchPersistentContext(this.profileDirectory, options);
    } catch (error) {
      throw coded(classifyLaunchError(error));
    }
    const guard = { blockedMutationRequests: 0 };
    try {
      if (readOnly) await installReadOnlyNetworkGuard(context, guard);
      else await installInteractiveAIInsightsGuard(context);
      context.setDefaultTimeout(10_000);
      context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
      return await callback(context, guard);
    } finally {
      await context.close().catch(() => {});
    }
  }

  #serialized(operation) {
    const run = this.queue.then(operation, operation);
    this.queue = run.catch(() => {});
    return run;
  }
}

export async function loadPlaywrightCore() {
  try {
    return await import('playwright-core');
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  }
  for (const candidate of playwrightModuleCandidates()) {
    try {
      if (fs.existsSync(candidate)) return await import(pathToFileURL(candidate).href);
    } catch {
      // Continue to another reviewed installation location without logging a
      // path, browser profile, page, or authentication material.
    }
  }
  throw coded('colleague_zone_playwright_unavailable');
}

export async function resolveBrowserExecutable(chromium) {
  for (const candidate of BROWSER_EXECUTABLE_CANDIDATES) {
    if (isExecutableFile(candidate)) return candidate;
  }
  try {
    const bundled = chromium.executablePath();
    if (isExecutableFile(bundled)) return bundled;
  } catch {
    // A playwright-core installation does not necessarily include Chromium.
  }
  throw coded('colleague_zone_browser_executable_unavailable');
}

export async function browserRuntimeHealth({
  playwrightLoader = loadPlaywrightCore,
  executableResolver = resolveBrowserExecutable,
} = {}) {
  try {
    const playwright = await playwrightLoader();
    if (!playwright?.chromium?.launchPersistentContext) throw coded('colleague_zone_playwright_unavailable');
    await executableResolver(playwright.chromium);
    return Object.freeze({
      schema: 'rico.colleague-zone-browser-health',
      schemaVersion: 1,
      ready: true,
      playwrightCore: 'ready',
      chromium: 'ready',
      errorCode: null,
    });
  } catch (error) {
    const code = safeCode(error);
    return Object.freeze({
      schema: 'rico.colleague-zone-browser-health',
      schemaVersion: 1,
      ready: false,
      playwrightCore: code === 'colleague_zone_playwright_unavailable' ? 'unavailable' : 'ready',
      chromium: 'unavailable',
      errorCode: publicHealthErrorCode(code),
    });
  }
}

async function installReadOnlyNetworkGuard(context, guard) {
  await context.route('**/*', async (route) => {
    const request = route.request();
    const method = String(request.method()).toUpperCase();
    if (!isSafeReadRequest(method, request.url())) {
      guard.blockedMutationRequests += 1;
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  await installAIInsightsDOMGuard(context);
}

async function installInteractiveAIInsightsGuard(context) {
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (isAIInsightsMutationRequest(request.method(), request.url())) {
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  await installAIInsightsDOMGuard(context);
}

async function installAIInsightsDOMGuard(context) {
  await context.addInitScript(forbiddenActionInitScript, COLLEAGUE_ZONE_SELECTORS.forbiddenActions.visibleLabels);
  for (const page of context.pages()) await installAIInsightsInteractionBlock(page);
  context.on('page', (page) => void installAIInsightsInteractionBlock(page));
}

async function installAIInsightsInteractionBlock(page) {
  await page.addInitScript(forbiddenActionInitScript, COLLEAGUE_ZONE_SELECTORS.forbiddenActions.visibleLabels).catch(() => {});
}

function forbiddenActionInitScript(labels) {
  const forbidden = new Set(labels.map((item) => item.toLowerCase().replace(/\s+/g, ' ').trim()));
  document.addEventListener('click', (event) => {
    const target = event.target?.closest?.('button, a, [role="button"]');
    const text = String(target?.textContent ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    if ([...forbidden].some((label) => text.includes(label))) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
}

async function navigate(page, url, timeout) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForTimeout(500);
}

async function authenticationSnapshot(page) {
  const selectors = COLLEAGUE_ZONE_SELECTORS.authentication;
  const [passwordInputPresent, serviceLinkCount, headings] = await Promise.all([
    page.locator(selectors.passwordInput).count().then((count) => count > 0),
    page.locator(selectors.serviceDetailLink).count(),
    page.locator(selectors.currentStatusHeading).allInnerTexts(),
  ]);
  return Object.freeze({
    url: page.url(),
    passwordInputPresent,
    serviceLinkCount,
    visibleHeadingText: headings.join(' '),
  });
}

async function overviewSnapshot(page) {
  const selectors = COLLEAGUE_ZONE_SELECTORS.overview;
  const links = await page.locator(selectors.serviceDetailLink).evaluateAll((nodes, containingRecord) => nodes.map((node) => ({
    href: node.href,
    text: node.innerText ?? node.textContent ?? '',
    contextText: node.closest(containingRecord)?.innerText ?? node.parentElement?.innerText ?? '',
  })), selectors.containingRecord);
  return Object.freeze({ links });
}

async function detailSnapshot(page) {
  const selectors = COLLEAGUE_ZONE_SELECTORS.detail;
  const [title, headings, bodyText, times, records, incidentIdentities, aiInsightTexts] = await Promise.all([
    page.locator(selectors.title).first().innerText().catch(() => ''),
    page.locator(selectors.headings).allInnerTexts(),
    page.locator('body').innerText(),
    page.locator(selectors.times).evaluateAll((nodes) => nodes.slice(0, 200).map((node) => ({
      dateTime: node.getAttribute('datetime') ?? node.getAttribute('data-datetime') ?? node.getAttribute('data-timestamp'),
      text: node.innerText ?? node.textContent ?? '',
      contextText: node.closest('tr, [role="row"], li, article, section, div')?.innerText ?? '',
    }))),
    page.locator(selectors.incidentRecords).evaluateAll((nodes) => nodes.slice(0, 500).map((node) => ({
      text: node.innerText ?? node.textContent ?? '',
      incidentId: node.getAttribute('data-incident-id') ?? node.getAttribute('data-sys-id') ?? '',
      times: [...node.querySelectorAll('time, [data-datetime], [data-timestamp]')].slice(0, 20).map((time) => ({
        dateTime: time.getAttribute('datetime') ?? time.getAttribute('data-datetime') ?? time.getAttribute('data-timestamp'),
        text: time.innerText ?? time.textContent ?? '',
        contextText: time.closest('tr, [role="row"], li, article, section, div')?.innerText ?? '',
      })),
    })).filter((record) => /\b(?:major|significant|degrad(?:ed|ation)|disruption|issues?|incident)\b/i.test(record.text))),
    page.locator(selectors.incidentIdentity).evaluateAll((nodes) => nodes.slice(0, 5).map((node) =>
      node.getAttribute('data-incident-id') ?? node.getAttribute('data-sys-id') ?? node.getAttribute('data-incident-sys-id') ?? '')),
    page.locator(selectors.existingAIInsight).allInnerTexts(),
  ]);
  return Object.freeze({
    url: page.url(), title, headings, bodyText, times, records,
    incidentId: incidentIdentities.find(Boolean) ?? '',
    aiInsightTexts,
  });
}

function ensurePrivateProfileDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw coded('colleague_zone_profile_directory_invalid');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw coded('colleague_zone_profile_directory_owner_invalid');
  if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(directory, 0o700);
}

function playwrightModuleCandidates() {
  const candidates = new Set([
    '/opt/homebrew/lib/node_modules/openclaw/node_modules/playwright-core/index.mjs',
    '/usr/local/lib/node_modules/openclaw/node_modules/playwright-core/index.mjs',
  ]);
  const entry = String(process.argv[1] ?? '');
  if (path.isAbsolute(entry)) {
    let cursor = path.dirname(entry);
    for (let index = 0; index < 8; index += 1) {
      candidates.add(path.join(cursor, 'node_modules', 'playwright-core', 'index.mjs'));
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  return [...candidates];
}

function isExecutableFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    fs.accessSync(filePath, fs.constants.X_OK);
    return stat.isFile();
  } catch { return false; }
}

function isAIInsightsMutationURL(value) {
  try {
    const url = new URL(String(value));
    return COLLEAGUE_ZONE_SELECTORS.forbiddenActions.requestURLPattern.test(`${url.pathname}${url.search}`);
  } catch { return true; }
}

export function isAIInsightsMutationRequest(method, value) {
  let pathAndQuery;
  try {
    const url = new URL(String(value));
    pathAndQuery = `${url.pathname}${url.search}`;
  } catch { return true; }
  return isAIInsightsMutationURL(value)
    || (!SAFE_READ_METHODS.has(String(method ?? '').toUpperCase())
      && COLLEAGUE_ZONE_SELECTORS.forbiddenActions.anyRequestURLPattern.test(pathAndQuery));
}

export function isSafeReadRequest(method, url) {
  return SAFE_READ_METHODS.has(String(method ?? '').toUpperCase()) && !isAIInsightsMutationURL(url);
}

function assertDetailPageURL(actual, expected) {
  if (new URL(actual).toString() !== new URL(expected).toString()) throw coded('colleague_zone_detail_navigation_mismatch');
}

function classifyLaunchError(error) {
  const message = String(error?.message ?? '');
  if (/profile.*(?:in use|lock)|processsingleton|singletonlock/iu.test(message)) return 'colleague_zone_profile_busy';
  if (/executable.*(?:doesn.?t exist|not found)|browser.*not found/iu.test(message)) return 'colleague_zone_browser_executable_unavailable';
  return 'colleague_zone_browser_launch_failed';
}

function safeCode(error) {
  return String(error?.code ?? error?.name ?? 'unknown').toLowerCase().replace(/[^a-z0-9_-]+/gu, '_').slice(0, 80) || 'unknown';
}

function publicHealthErrorCode(code) {
  return new Set([
    'colleague_zone_playwright_unavailable',
    'colleague_zone_browser_executable_unavailable',
  ]).has(code) ? code : 'colleague_zone_browser_runtime_unavailable';
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
