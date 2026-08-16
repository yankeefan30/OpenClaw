import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  COLLEAGUE_ZONE_CONTRACT,
  COLLEAGUE_ZONE_SOURCE_ID,
  COLLEAGUE_ZONE_URL,
} from '../definition.mjs';
import { ColleagueZoneBrowserReader } from './browser-runtime.mjs';

const PROFILE_DIRECTORY_NAME = 'colleague-zone-browser-profile';

export async function createColleagueZoneStatusAdapter(context) {
  const source = validateContext(context);
  const reader = new ColleagueZoneBrowserReader({
    profileDirectory: profileDirectory(context.stateDirectory, source.profileId),
  });
  return Object.freeze(new ColleagueZoneStatusAdapter({ source, reader }));
}

export class ColleagueZoneStatusAdapter {
  constructor({ source, reader, now = () => new Date() }) {
    this.source = validateSource(source);
    if (!reader || typeof reader.preflight !== 'function' || typeof reader.readActiveServiceStatus !== 'function') {
      throw coded('colleague_zone_browser_reader_invalid');
    }
    this.reader = reader;
    this.now = now;
  }

  async preflight(request) {
    validatePreflightRequest(request, this.source);
    const state = await this.reader.preflight({ pageUrl: this.source.pageUrl });
    const ready = state?.runtimeState === 'ready' && state?.authenticationState === 'ready';
    return Object.freeze({
      ok: ready,
      contract: COLLEAGUE_ZONE_CONTRACT,
      sourceId: this.source.sourceId,
      pageUrl: this.source.pageUrl,
      profileId: this.source.profileId,
      authenticationState: ready ? 'ready' : (state?.authenticationState === 'reauth-required' ? 'reauth-required' : 'unavailable'),
      authenticatedReadReady: ready,
      readOnly: true,
      browserRuntimeState: state?.runtimeState === 'ready' ? 'ready' : 'unavailable',
      browserRuntimeErrorCode: state?.runtimeState === 'ready' ? null : publicRuntimeErrorCode(state?.errorCode),
      dedicatedPersistentProfile: true,
      headlessReadOnly: true,
      browserAutomationUsed: true,
      cookiesReadOrExported: false,
      passwordOrOTPHandled: false,
      mutationRequestsBlocked: true,
      credentialMaterialLogged: false,
      aiInsightGenerationDisabled: true,
    });
  }

  async readActiveServiceStatus(request) {
    validateStatusRequest(request, this.source);
    const snapshotAt = this.now().toISOString();
    let result;
    try {
      result = await this.reader.readActiveServiceStatus({
        pageUrl: this.source.pageUrl,
        maxItems: request.maxItems,
        snapshotAt,
      });
    } catch (error) {
      if (safeCode(error) === 'colleague_zone_reauth_required') {
        error.reauth = safeReauthDescriptor(this.source.pageUrl);
      }
      throw error;
    }
    if (result?.sideEffectsPerformed !== false || result?.aiInsightGenerationAttempted !== false
      || !Array.isArray(result?.incidents)) throw coded('colleague_zone_read_proof_invalid');
    return Object.freeze({
      sourceId: this.source.sourceId,
      pageUrl: this.source.pageUrl,
      profileId: this.source.profileId,
      snapshotAt,
      readOnly: true,
      sideEffectsPerformed: false,
      aiInsightGenerationAttempted: false,
      incidents: Object.freeze(result.incidents.slice(0, request.maxItems)),
    });
  }
}

export async function runInteractiveColleagueZoneReauth({ source, stateDirectory, timeoutMs, onState }) {
  const validated = validateSource(source);
  const reader = new ColleagueZoneBrowserReader({
    profileDirectory: profileDirectory(stateDirectory, validated.profileId),
  });
  return reader.interactiveReauth({ pageUrl: validated.pageUrl, timeoutMs, onState });
}

export function profileDirectory(stateDirectory, profileId) {
  if (!path.isAbsolute(String(stateDirectory ?? ''))) throw coded('colleague_zone_state_directory_invalid');
  const suffix = createHash('sha256').update(String(profileId), 'utf8').digest('hex').slice(0, 16);
  return path.join(path.normalize(stateDirectory), PROFILE_DIRECTORY_NAME, suffix);
}

function validateContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw coded('colleague_zone_adapter_context_invalid');
  const source = validateSource(context.source);
  if (!path.isAbsolute(String(context.stateDirectory ?? ''))) throw coded('colleague_zone_state_directory_invalid');
  const policy = context.sessionPolicy;
  if (!policy || policy.interactiveReauthOnly !== true || policy.passwordOrOTPAutomationAllowed !== false
    || policy.browserCookieInspectionOrExportAllowed !== false
    || policy.sessionStorage !== 'browser-managed-dedicated-profile'
    || policy.daemonHeadlessReadAllowed !== true) throw coded('colleague_zone_session_policy_invalid');
  return source;
}

function validateSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw coded('colleague_zone_source_invalid');
  if (source.sourceId !== COLLEAGUE_ZONE_SOURCE_ID || source.pageUrl !== COLLEAGUE_ZONE_URL) {
    throw coded('colleague_zone_source_mismatch');
  }
  const profileId = bounded(source.profileId, 1, 256, 'colleague_zone_profile_id_invalid');
  return Object.freeze({ sourceId: COLLEAGUE_ZONE_SOURCE_ID, pageUrl: COLLEAGUE_ZONE_URL, profileId });
}

function validatePreflightRequest(request, source) {
  if (!request || request.contract !== COLLEAGUE_ZONE_CONTRACT || request.sourceId !== source.sourceId
    || request.pageUrl !== source.pageUrl || request.profileId !== source.profileId
    || request.interactiveReauthOnly !== true || request.daemonBrowserAutomationAllowed !== true
    || request.browserProfileMode !== 'dedicated-persistent' || request.passwordOrOTPInputAllowed !== false
    || request.browserCookieInspectionOrExportAllowed !== false || request.sessionStorage !== 'browser-managed-profile') {
    throw coded('colleague_zone_preflight_request_invalid');
  }
  const capabilities = [
    'authenticated.read-only.service-status',
    'active.major-significant.only',
    'existing-ai-insights.read-if-present',
    'ai-insight-generation-disabled',
    'dedicated-playwright-persistent-profile',
    'browser-cookie-inspection-and-export-disabled',
    'mutation-requests-blocked-during-read',
    'no-password-or-otp-automation',
  ];
  if (JSON.stringify(request.requiredCapabilities) !== JSON.stringify(capabilities)) {
    throw coded('colleague_zone_preflight_capabilities_invalid');
  }
}

function validateStatusRequest(request, source) {
  if (!request || request.contract !== COLLEAGUE_ZONE_CONTRACT || request.sourceId !== source.sourceId
    || request.pageUrl !== source.pageUrl || request.profileId !== source.profileId
    || request.status !== 'active' || request.readOnly !== true || request.browserAutomationAllowed !== true
    || request.browserProfileMode !== 'dedicated-persistent'
    || JSON.stringify(request.allowedHTTPMethods) !== JSON.stringify(['GET', 'HEAD', 'OPTIONS'])
    || request.executePageInstructions !== false || request.credentialMaterialAllowed !== false
    || request.triggerAIInsightsGeneration !== false || request.readExistingAIInsightsIfAlreadyPresent !== true
    || !Number.isInteger(request.maxItems) || request.maxItems < 1 || request.maxItems > 100) {
    throw coded('colleague_zone_status_request_invalid');
  }
  const fields = ['incidentId', 'serviceId', 'detailUrl', 'severity', 'status', 'serviceName', 'environment', 'startedAt', 'updatedAt', 'durationMinutes', 'safeSummary', 'existingAIInsight'];
  if (JSON.stringify(request.severities) !== JSON.stringify(['Major', 'Significant'])
    || JSON.stringify(request.overviewSections) !== JSON.stringify(['Current Status'])
    || request.detailPageId !== 'my_services_status'
    || JSON.stringify(request.fields) !== JSON.stringify(fields)) throw coded('colleague_zone_status_scope_invalid');
}

function safeReauthDescriptor(url) {
  return Object.freeze({
    schema: 'rico.colleague-zone-reauth',
    schemaVersion: 2,
    state: 'user-action-required',
    url,
    instructions: 'Complete sign-in and MFA in the dedicated browser window.',
  });
}

function publicRuntimeErrorCode(value) {
  const code = safeCode({ code: value });
  return new Set([
    'colleague_zone_playwright_unavailable',
    'colleague_zone_browser_executable_unavailable',
    'colleague_zone_profile_busy',
    'colleague_zone_browser_launch_failed',
  ]).has(code) ? code : 'colleague_zone_browser_runtime_unavailable';
}

function bounded(value, minimum, maximum, code) {
  const normalized = String(value ?? '').trim();
  if (normalized.length < minimum || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) throw coded(code);
  return normalized;
}

function safeCode(error) {
  return String(error?.code ?? error?.name ?? 'unknown').toLowerCase().replace(/[^a-z0-9_-]+/gu, '_').slice(0, 80) || 'unknown';
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
