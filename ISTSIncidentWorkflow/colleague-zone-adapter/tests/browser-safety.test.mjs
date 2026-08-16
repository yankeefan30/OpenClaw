import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { browserRuntimeHealth, isAIInsightsMutationRequest, isSafeReadRequest } from '../browser-runtime.mjs';

test('headless read guard allows only safe methods and blocks AI Insight generation URLs', () => {
  assert.equal(isSafeReadRequest('GET', 'https://colleaguezone.cvs.com/cz?id=services_status'), true);
  assert.equal(isSafeReadRequest('HEAD', 'https://colleaguezone.cvs.com/assets/status.css'), true);
  assert.equal(isSafeReadRequest('OPTIONS', 'https://colleaguezone.cvs.com/api/status'), true);
  assert.equal(isSafeReadRequest('POST', 'https://colleaguezone.cvs.com/api/status'), false);
  assert.equal(isSafeReadRequest('PUT', 'https://colleaguezone.cvs.com/api/status'), false);
  assert.equal(isSafeReadRequest('GET', 'https://colleaguezone.cvs.com/api/generate-ai-insight'), false);
  assert.equal(isAIInsightsMutationRequest('POST', 'https://colleaguezone.cvs.com/api/ai-insights'), true);
  assert.equal(isAIInsightsMutationRequest('GET', 'https://colleaguezone.cvs.com/api/ai-insights/existing'), false);
});

test('browser worker source has no cookie, storage-state, password-value, OTP, screenshot, or request-body extraction', () => {
  const file = fileURLToPath(new URL('../browser-runtime.mjs', import.meta.url));
  const source = fs.readFileSync(file, 'utf8');
  for (const forbidden of [
    /\.cookies\s*\(/u,
    /storageState\s*\(/u,
    /inputValue\s*\(/u,
    /postData/u,
    /screenshot\s*\(/u,
    /\.click\s*\(/u,
    /oneTime|one_time|\botp\b/iu,
    /console\.(?:log|error|warn)/u,
  ]) assert.equal(forbidden.test(source), false, `forbidden browser extraction matched ${forbidden}`);
});

test('runtime health is bounded and never returns an executable path', async () => {
  const ready = await browserRuntimeHealth({
    playwrightLoader: async () => ({ chromium: { launchPersistentContext() {} } }),
    executableResolver: async () => '/fictional/private/path/chromium',
  });
  assert.deepEqual(ready, {
    schema: 'rico.colleague-zone-browser-health',
    schemaVersion: 1,
    ready: true,
    playwrightCore: 'ready',
    chromium: 'ready',
    errorCode: null,
  });
  assert.equal(JSON.stringify(ready).includes('/fictional'), false);

  const unavailable = await browserRuntimeHealth({
    playwrightLoader: async () => { throw Object.assign(new Error('sensitive path'), { code: 'colleague_zone_playwright_unavailable' }); },
  });
  assert.equal(unavailable.ready, false);
  assert.equal(unavailable.errorCode, 'colleague_zone_playwright_unavailable');
  assert.equal(JSON.stringify(unavailable).includes('sensitive path'), false);
});
