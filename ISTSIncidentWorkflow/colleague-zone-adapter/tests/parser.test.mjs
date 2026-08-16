import assert from 'node:assert/strict';
import test from 'node:test';
import { parseActiveIncident, parseDetailURL, parseOverviewSnapshot } from '../parser.mjs';

const DETAIL = 'https://colleaguezone.cvs.com/cz?id=my_services_status&service=83b7dd271bac955cab635536624bcb12';

test('overview parsing accepts only exact Colleague Zone detail URLs and deduplicates services', () => {
  const candidates = parseOverviewSnapshot({ links: [
    { href: DETAIL, text: 'Guided Personal Service :: PROD', contextText: 'Current Status Major Multiple issues' },
    { href: DETAIL, text: 'duplicate', contextText: 'duplicate' },
    { href: 'https://evil.example/cz?id=my_services_status&service=stolen', text: 'bad host', contextText: 'Major' },
    { href: `${DETAIL}&next=https://evil.example`, text: 'extra parameter', contextText: 'Major' },
  ] });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].serviceId, '83b7dd271bac955cab635536624bcb12');
  assert.equal(parseDetailURL(`${DETAIL}#fragment`), null);
});

test('active scoped records are ranked ahead of healthy navigation links', () => {
  const active = 'https://colleaguezone.cvs.com/cz?id=my_services_status&service=active-service';
  const candidates = parseOverviewSnapshot({ links: [
    { href: DETAIL, text: 'Healthy navigation item', contextText: 'All systems operational' },
    { href: active, text: 'Identity :: PROD', contextText: 'Current Status Significant Active issue' },
  ] });
  assert.equal(candidates[0].serviceId, 'active-service');
});

test('detail parsing returns stable active Major metadata without page provenance', () => {
  const candidate = parseOverviewSnapshot({ links: [{
    href: DETAIL,
    text: 'Guided Personal Service :: PROD',
    contextText: 'Current Status Major Multiple issues',
  }] })[0];
  const incident = parseActiveIncident(candidate, {
    url: DETAIL,
    title: 'Guided Personal Service :: PROD',
    headings: ['Guided Personal Service :: PROD', 'Major', 'Multiple issues'],
    bodyText: [
      'Status: Active',
      'Major degradation',
      'Started August 15, 2026 at 6:00 AM ET',
      'Last updated August 15, 2026 at 2:23 PM ET',
      'Duration 8 hours 23 minutes',
    ].join('\n'),
    times: [],
    incidentId: '',
    aiInsightTexts: [],
  }, { snapshotAt: '2026-08-15T18:30:00.000Z' });
  assert.equal(incident.severity, 'Major');
  assert.equal(incident.status, 'active');
  assert.equal(incident.serviceName, 'Guided Personal Service');
  assert.equal(incident.environment, 'Production');
  assert.equal(incident.startedAt, '2026-08-15T10:00:00.000Z');
  assert.equal(incident.updatedAt, '2026-08-15T18:23:00.000Z');
  assert.equal(incident.durationMinutes, 503);
  assert.match(incident.incidentId, /^cz-[a-f0-9]{40}$/u);
  assert.equal(incident.safeSummary, 'Guided Personal Service has an active major issue in Production');
  assert.equal(incident.safeSummary.includes('Colleague'), false);
});

test('resolved entries and AI Insights buttons are never returned as active content', () => {
  const candidate = parseOverviewSnapshot({ links: [{
    href: DETAIL,
    text: 'Guided Personal Service :: PROD',
    contextText: 'Significant',
  }] })[0];
  const closed = parseActiveIncident(candidate, {
    url: DETAIL,
    title: 'Guided Personal Service :: PROD',
    headings: ['Significant'],
    bodyText: 'Resolved August 15, 2026 at 2:23 PM ET. No current issues.',
    times: [],
    aiInsightTexts: ['View AI Insights'],
  }, { snapshotAt: '2026-08-15T18:30:00.000Z' });
  assert.equal(closed, null);
});

test('existing AI insight text may be read only when it is already present and safe', () => {
  const candidate = parseOverviewSnapshot({ links: [{
    href: DETAIL,
    text: 'Guided Personal Service :: PROD',
    contextText: 'Significant Active issue',
  }] })[0];
  const incident = parseActiveIncident(candidate, {
    url: DETAIL,
    title: 'Guided Personal Service :: PROD',
    headings: ['Significant', 'Active'],
    bodyText: 'Started August 15, 2026 at 6:00 AM ET',
    times: [],
    aiInsightTexts: ['Authentication latency is elevated for a subset of requests.'],
  }, { snapshotAt: '2026-08-15T18:30:00.000Z' });
  assert.deepEqual(incident.existingAIInsight, {
    present: true,
    safeSummary: 'Authentication latency is elevated for a subset of requests.',
  });
});

test('existing insight provenance or links are dropped instead of entering Rico context', () => {
  const candidate = parseOverviewSnapshot({ links: [{
    href: DETAIL,
    text: 'Guided Personal Service :: PROD',
    contextText: 'Significant Active issue',
  }] })[0];
  const incident = parseActiveIncident(candidate, {
    url: DETAIL,
    title: 'Guided Personal Service :: PROD',
    headings: ['Significant', 'Active'],
    bodyText: 'Started August 15, 2026 at 6:00 AM ET',
    times: [],
    aiInsightTexts: ['According to the Colleague Zone recording, see https://private.example.'],
  }, { snapshotAt: '2026-08-15T18:30:00.000Z' });
  assert.deepEqual(incident.existingAIInsight, { present: false, safeSummary: null });
});

test('an ongoing row wins over a newer completed historical degradation', () => {
  const candidate = parseOverviewSnapshot({ links: [{
    href: DETAIL,
    text: 'Guided Personal Service :: PROD',
    contextText: 'Major Multiple issues',
  }] })[0];
  const incident = parseActiveIncident(candidate, {
    url: DETAIL,
    title: 'Guided Personal Service :: PROD',
    headings: ['Major', 'Multiple issues'],
    bodyText: 'Service history',
    records: [
      { text: 'Degradation started August 15, 2026 at 6:00 AM ET. Ended with duration 8 hours 23 minutes.', times: [] },
      { text: 'Ongoing degradation started August 13, 2026 at 11:00 AM ET.', incidentId: 'active-revision-83', times: [] },
    ],
    times: [],
    aiInsightTexts: [],
  }, { snapshotAt: '2026-08-15T18:30:00.000Z' });
  assert.equal(incident.incidentId, 'active-revision-83');
  assert.equal(incident.startedAt, '2026-08-13T15:00:00.000Z');
  assert.equal(incident.durationMinutes, 3_090);
});

test('generic source headings cannot become the service name', () => {
  const candidate = parseOverviewSnapshot({ links: [{
    href: DETAIL,
    text: 'Guided Personal Service :: PROD',
    contextText: 'Major Active issue',
  }] })[0];
  const incident = parseActiveIncident(candidate, {
    url: DETAIL,
    title: 'Colleague Zone',
    headings: ['Colleague Zone', 'Major'],
    bodyText: 'Active degradation started August 15, 2026 at 6:00 AM ET',
    times: [],
    aiInsightTexts: [],
  }, { snapshotAt: '2026-08-15T18:30:00.000Z' });
  assert.equal(incident.serviceName, 'Guided Personal Service');
  assert.equal(incident.safeSummary.includes('Colleague'), false);
});
