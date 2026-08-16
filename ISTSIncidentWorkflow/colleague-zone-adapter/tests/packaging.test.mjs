import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('signed-app packaging includes the complete adapter and interactive reauth closure', () => {
  const packageScript = fileURLToPath(new URL('../../../scripts/package-app.sh', import.meta.url));
  const source = fs.readFileSync(packageScript, 'utf8');
  for (const relative of [
    'ISTSIncidentWorkflow/colleague-zone-adapter/index.mjs',
    'ISTSIncidentWorkflow/colleague-zone-adapter/browser-runtime.mjs',
    'ISTSIncidentWorkflow/colleague-zone-adapter/parser.mjs',
    'ISTSIncidentWorkflow/colleague-zone-adapter/selectors.mjs',
    'ISTSIncidentWorkflow/colleague-zone-adapter/scripts/reauth.mjs',
    'ISTSIncidentWorkflow/scripts/ists-incident.mjs',
  ]) assert.match(source, new RegExp(relative.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'));
  assert.match(source, /Resources\/RicoRecipientGuard\/ISTSIncidentWorkflow\/colleague-zone-adapter/u);
  assert.match(source, /Resources\/ISTSIncidentWorkflow\/colleague-zone-adapter/u);
});
