import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  colleagueZonePreflightRequest,
  colleagueZoneStatusRequest,
  validateColleagueZonePreflightProof,
  validateColleagueZoneStatus,
} from '../../contracts.mjs';
import { validatePermissionGrant } from '../../grant.mjs';
import { permissionGrant, serviceIncident } from '../../tests/fixtures.mjs';
import { ColleagueZoneStatusAdapter, profileDirectory } from '../index.mjs';

function enabledGrant() {
  return validatePermissionGrant(permissionGrant({ colleagueZone: {
    enabled: true,
    sourceId: 'cvs-colleague-zone:service-status',
    pageUrl: 'https://colleaguezone.cvs.com/cz?id=services_status',
    profileId: 'reviewed-cvs-status-session',
  } }));
}

test('adapter satisfies the v2 persistent-profile contract without credential fields', async () => {
  const grant = enabledGrant();
  const calls = [];
  const reader = {
    async preflight(input) { calls.push(['preflight', input]); return { runtimeState: 'ready', authenticationState: 'ready' }; },
    async readActiveServiceStatus(input) {
      calls.push(['read', input]);
      return {
        incidents: [serviceIncident()],
        sideEffectsPerformed: false,
        aiInsightGenerationAttempted: false,
        blockedMutationRequests: 2,
      };
    },
  };
  const adapter = new ColleagueZoneStatusAdapter({ source: grant.colleagueZone, reader, now: () => new Date('2026-08-15T12:03:00.000Z') });
  const preflight = await adapter.preflight(colleagueZonePreflightRequest(grant));
  assert.equal(validateColleagueZonePreflightProof(preflight, grant), true);
  assert.equal(preflight.dedicatedPersistentProfile, true);
  assert.equal(preflight.cookiesReadOrExported, false);
  assert.equal(preflight.passwordOrOTPHandled, false);
  assert.equal(preflight.credentialMaterialLogged, false);
  assert.equal(JSON.stringify(preflight).match(/cookie|password|otp/giu)?.length > 0, true);

  const status = await adapter.readActiveServiceStatus(colleagueZoneStatusRequest(grant));
  const validated = validateColleagueZoneStatus(status, grant);
  assert.equal(validated.incidents.length, 1);
  assert.equal(calls[1][1].pageUrl, grant.colleagueZone.pageUrl);
  assert.equal(Object.hasOwn(calls[1][1], 'password'), false);
  assert.equal(Object.hasOwn(calls[1][1], 'cookies'), false);
});

test('expired session returns only a user-completed reauth descriptor', async () => {
  const grant = enabledGrant();
  const adapter = new ColleagueZoneStatusAdapter({
    source: grant.colleagueZone,
    reader: {
      async preflight() { return { runtimeState: 'ready', authenticationState: 'reauth-required' }; },
      async readActiveServiceStatus() { throw new Error('must not read'); },
    },
  });
  const proof = await adapter.preflight(colleagueZonePreflightRequest(grant));
  let error;
  try { validateColleagueZonePreflightProof(proof, grant); } catch (caught) { error = caught; }
  assert.equal(error.code, 'colleague_zone_reauth_required');
  assert.equal(error.reauth.url, grant.colleagueZone.pageUrl);
  assert.equal(error.reauth.mfaHandling, 'user-completed');
  assert.equal(error.reauth.passwordOrOTPAutomationAllowed, false);
  assert.equal(JSON.stringify(error.reauth).includes('token'), false);
});

test('missing browser runtime fails closed with a bounded public error code', async () => {
  const grant = enabledGrant();
  const adapter = new ColleagueZoneStatusAdapter({
    source: grant.colleagueZone,
    reader: {
      async preflight() {
        return { runtimeState: 'unavailable', authenticationState: 'unavailable', errorCode: 'colleague_zone_browser_executable_unavailable' };
      },
      async readActiveServiceStatus() { throw new Error('must not read'); },
    },
  });
  const proof = await adapter.preflight(colleagueZonePreflightRequest(grant));
  assert.throws(() => validateColleagueZonePreflightProof(proof, grant), /colleague_zone_browser_executable_unavailable/u);
});

test('profile directory is deterministic, private-source-neutral, and contained by state directory', () => {
  const state = path.join(os.tmpdir(), 'rico-ists-adapter-test');
  const first = profileDirectory(state, 'reviewed-profile-with-human-name');
  const second = profileDirectory(state, 'reviewed-profile-with-human-name');
  assert.equal(first, second);
  assert.equal(first.startsWith(`${state}${path.sep}`), true);
  assert.equal(first.includes('reviewed-profile-with-human-name'), false);
});
