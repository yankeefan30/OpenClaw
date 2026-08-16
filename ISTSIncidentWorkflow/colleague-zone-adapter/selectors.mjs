// All Colleague Zone DOM selectors live here. Keeping them in one reviewed
// object makes ServiceNow/MoveWorks markup drift a localized repair.
export const COLLEAGUE_ZONE_SELECTORS = deepFreeze({
  authentication: {
    passwordInput: 'input[type="password"]',
    usernameInput: 'input[type="email"], input[name*="user" i], input[autocomplete="username"]',
    serviceDetailLink: 'a[href*="/cz?"][href*="id=my_services_status"][href*="service="]',
    currentStatusHeading: 'h1, h2, h3, [role="heading"]',
  },
  overview: {
    serviceDetailLink: 'a[href*="/cz?"][href*="id=my_services_status"][href*="service="]',
    containingRecord: 'tr, [role="row"], li, article, section, [class*="card" i], [class*="status" i]',
  },
  detail: {
    title: 'h1, [role="heading"][aria-level="1"]',
    headings: 'h1, h2, h3, [role="heading"]',
    times: 'time, [data-datetime], [data-timestamp], [class*="time" i], [class*="date" i]',
    incidentRecords: '[data-incident-id], [data-status], [class*="incident" i], [class*="issue" i], [class*="event" i], tr, [role="row"], li, article',
    incidentIdentity: '[data-incident-id], [data-sys-id], [data-incident-sys-id]',
    existingAIInsight: '[data-testid*="ai-insight-content" i], [class*="ai-insight-content" i], [data-ai-insight="content"]',
  },
  forbiddenActions: {
    visibleLabels: ['View AI insights', 'Generate AI insights', 'Regenerate AI insights'],
    anyRequestURLPattern: /ai[-_]?insights?/iu,
    requestURLPattern: /(?:generate|create|regenerate)[^/?#]*ai[-_]?insight|ai[-_]?insight[^/?#]*(?:generate|create|regenerate)/iu,
  },
});

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
