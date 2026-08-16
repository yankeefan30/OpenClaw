import assert from "node:assert/strict";
import test from "node:test";
import { ISTSJeffContextProvider } from "../context-provider.mjs";
import { validatePermissionGrant } from "../grant.mjs";
import {
  fakeAdapter,
  fakeColleagueZoneAdapter,
  incidentMessage,
  jeffOriginProof,
  permissionGrant,
  serviceIncident,
} from "./fixtures.mjs";

test("an exact trusted Jeff direct origin gets private-source-safe background context", async () => {
  const grant = validatePermissionGrant(permissionGrant());
  const adapter = fakeAdapter(grant, {
    contextMessages: [incidentMessage({ messageId: "context-1" })],
    summary: "a production authentication failure affecting the ISTS portal",
  });
  const provider = new ISTSJeffContextProvider({ permissionGrant: grant, adapter });
  const result = await provider.prepareForJeffReply({ originProof: jeffOriginProof(grant) });
  assert.equal(result.available, true);
  assert.match(result.contextNote, /^Current operational situation:/u);
  assert.match(result.contextNote, /Do not say or imply how Rico learned it\.$/u);
  assert.equal(result.internalUseOnly, true);
  assert.equal(result.sourceDisclosureForbidden, true);
  assert.equal(result.contextNote.includes("group chat"), false);
  assert.equal(adapter.calls.context.length, 1);
  assert.equal(adapter.calls.sends.length, 0);
});

test("Jeff pre-response context reads the separately reviewed Colleague Zone source without triggering AI Insights", async () => {
  const grant = validatePermissionGrant(permissionGrant({
    colleagueZone: {
      enabled: true,
      sourceId: "cvs-colleague-zone:service-status",
      pageUrl: "https://colleaguezone.cvs.com/cz?id=services_status",
      profileId: "reviewed-cvs-status-session",
    },
  }));
  const adapter = fakeAdapter(grant, { contextMessages: [] });
  const source = fakeColleagueZoneAdapter(grant, { statusBatches: [[serviceIncident()]] });
  const provider = new ISTSJeffContextProvider({ permissionGrant: grant, adapter, colleagueZoneAdapter: source });
  const result = await provider.prepareForJeffReply({ originProof: jeffOriginProof(grant) });
  assert.equal(result.available, true);
  assert.equal(adapter.calls.summaries[0].untrustedData.activeServiceStatus.length, 1);
  assert.equal(source.calls.reads[0].triggerAIInsightsGeneration, false);
  assert.equal(source.calls.reads[0].readExistingAIInsightsIfAlreadyPresent, true);
  assert.equal(adapter.calls.sends.length, 0);
});

test("a mismatched sender cannot trigger an ISTS context read", async () => {
  const grant = validatePermissionGrant(permissionGrant());
  const adapter = fakeAdapter(grant, { contextMessages: [incidentMessage()] });
  const provider = new ISTSJeffContextProvider({ permissionGrant: grant, adapter });
  const wrong = jeffOriginProof(grant, {
    profileId: "another-profile",
    principal: { kind: "phone", handle: "+12125550999" },
  });
  await assert.rejects(() => provider.prepareForJeffReply({ originProof: wrong }), /jeff_origin_mismatch/u);
  assert.equal(adapter.calls.preflight.length, 0);
  assert.equal(adapter.calls.context.length, 0);
});

test("no recent incident still returns only the fixed non-authorizing domain vocabulary", async () => {
  const grant = validatePermissionGrant(permissionGrant());
  const adapter = fakeAdapter(grant, { contextMessages: [] });
  const provider = new ISTSJeffContextProvider({ permissionGrant: grant, adapter });
  const result = await provider.prepareForJeffReply({ originProof: jeffOriginProof(grant) });
  assert.equal(result.available, true);
  assert.match(result.contextNote, /IMT and Command Center/u);
  assert.match(result.contextNote, /Do not infer any title, role, identity, access, or action authority/u);
  assert.equal(adapter.calls.summaries.length, 0);
});
