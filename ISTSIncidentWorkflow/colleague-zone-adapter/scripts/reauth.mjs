#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultGrantPath, defaultStateDirectory, readPrivateGrant } from '../../grant.mjs';
import { runInteractiveColleagueZoneReauth } from '../index.mjs';
import { browserRuntimeHealth } from '../browser-runtime.mjs';

const options = parseArguments(process.argv.slice(2));
if (options.statusOnly) {
  const health = await browserRuntimeHealth();
  process.stdout.write(`${JSON.stringify(health, null, 2)}\n`);
  if (!health.ready) process.exitCode = 1;
} else {
  const grant = readPrivateGrant(options.permissionFile);
  if (!grant.colleagueZone.enabled) fail('Colleague Zone monitoring is not enabled in the reviewed grant.');

  process.stdout.write('Opening the dedicated Colleague Zone sign-in browser. Complete credentials and MFA in that window; Rico never receives them.\n');
  try {
    await runInteractiveColleagueZoneReauth({
      source: grant.colleagueZone,
      stateDirectory: options.stateDirectory,
      timeoutMs: options.timeoutSeconds * 1_000,
      onState(state) {
        if (state === 'browser-open') process.stdout.write('Waiting for the authenticated Current Status page…\n');
        if (state === 'authenticated') process.stdout.write('Authenticated session verified. The browser will close now.\n');
      },
    });
  } catch (error) {
    fail(`Reauthentication did not complete (${safeCode(error)}).`);
  }
}

function parseArguments(arguments_) {
  let permissionFile = defaultGrantPath();
  let stateDirectory = path.join(defaultStateDirectory(), 'state');
  let timeoutSeconds = 600;
  let statusOnly = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const value = arguments_[index];
    if (value === '--permission-file') permissionFile = absolute(arguments_[++index], 'permission file');
    else if (value === '--state-directory') stateDirectory = absolute(arguments_[++index], 'state directory');
    else if (value === '--timeout-seconds') {
      timeoutSeconds = Number(arguments_[++index]);
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 60 || timeoutSeconds > 1_800) fail('Timeout must be between 60 and 1800 seconds.');
    } else if (value === '--status') statusOnly = true;
    else if (value === '--help') {
      const script = fileURLToPath(import.meta.url);
      process.stdout.write(`Usage: node ${script} [--status] [--permission-file /absolute/path] [--state-directory /absolute/path] [--timeout-seconds 600]\n`);
      process.exit(0);
    } else fail(`Unknown argument: ${String(value)}`);
  }
  if (statusOnly && (arguments_.length !== 1 || arguments_[0] !== '--status')) {
    fail('--status cannot be combined with reauthentication options.');
  }
  return { permissionFile, stateDirectory, timeoutSeconds, statusOnly };
}

function absolute(value, label) {
  if (!value || !path.isAbsolute(value)) fail(`${label} must be an absolute path.`);
  return path.normalize(value);
}

function safeCode(error) {
  return String(error?.code ?? error?.name ?? 'unknown').toLowerCase().replace(/[^a-z0-9_-]+/gu, '_').slice(0, 80) || 'unknown';
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
