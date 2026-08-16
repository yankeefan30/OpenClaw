import assert from "node:assert/strict";
import test from "node:test";
import {
  RICO_RESEARCH_SYSTEM_POLICY,
  authorizeResearchSources,
  privateProvenanceDisclosureReason,
  safePublicCitationURL,
  validateOutboundResearchCitations,
  validateResearchEvidence,
} from "./research-policy.js";

const evidence = (overrides = {}) => ({
  id: "evidence-1",
  source: "newspaper",
  use: "citable_authority",
  title: "A reported fact",
  publicURL: "https://example.org/story",
  locatorDigest: "a".repeat(64),
  collectedAt: "2026-08-15T12:00:00Z",
  ...overrides,
});

test("research policy names models as assistants and private stores as non-citable", () => {
  assert.match(RICO_RESEARCH_SYSTEM_POLICY, /ChatGPT, Claude, Grok, Gemini, and Perplexity are research assistants, not authorities/);
  assert.match(RICO_RESEARCH_SYSTEM_POLICY, /Google Drive, Gmail, Slack, Outlook, Apple Mail, private conversations, lifelogs, and recordings are private/);
  assert.match(RICO_RESEARCH_SYSTEM_POLICY, /Never mention Limitless or PLAUD/);
  assert.match(RICO_RESEARCH_SYSTEM_POLICY, /Approved private facts may inform the substance and personalization/);
});

test("outbound text cannot name, imply, or obfuscate private provenance", () => {
  const blocked = [
    "I found this in Limitless.",
    "According to your PLAUD recording, the deadline is Friday.",
    "Based on our previous conversation, you prefer Tuesday.",
    "You mentioned earlier that this was confidential.",
    "I reviewed your meeting transcript.",
    "In our chat last month, you preferred Tuesday.",
    "As we discussed, the deadline is Friday.",
    "When we last spoke, you preferred Tuesday.",
    "Our earlier conversation was useful.",
    "We talked about the deadline.",
    "You told me the deadline was Friday.",
    "Earlier, you said the deadline was Friday.",
    "I remember that you wanted a concise answer.",
    "I have access to your call recordings.",
    "I reviewed our previous conversation.",
    "Notes from our meeting identify the owner.",
    "Your Slack messages show that the deadline changed.",
    "I checked Outlook before answering.",
    "I searched your email for the date.",
    "I found this in Alan's Outlook mailbox.",
    "According to ServiceNow, the incident started at noon.",
    "The CVS service status dashboard shows a major incident.",
    "I checked ServiceNow before answering.",
    "I reviewed the service status page.",
    "Colleague Zone confirms the incident is active.",
    "The existing AI Insights summary identifies the dependency.",
    "I found this in L\u200Bimitless.",
    "P L A U D supplied the detail.",
  ];
  for (const text of blocked) assert.ok(privateProvenanceDisclosureReason(text), text);
});

test("the provenance gate does not block meetings or verified public-source language", () => {
  for (const text of [
    "The public court opinion sets out the governing standard.",
    "The published court transcript explains the judge's ruling.",
    "Please ask Janet to arrange a meeting for Tuesday.",
    "A conversation is sometimes the fastest way to resolve a misunderstanding.",
    "We should talk about the public ruling.",
    "Your exchange rate calculation is correct.",
    "Your discussion question is well framed.",
    "Apple Mail is a registered trademark.",
    "ServiceNow publishes public product documentation.",
    "The New York Times article supports this conclusion: https://www.nytimes.com/example",
  ]) assert.equal(privateProvenanceDisclosureReason(text), undefined, text);
});

test("only credential-free public HTTPS URLs are accepted", () => {
  assert.equal(safePublicCitationURL("https://example.org/story"), "https://example.org/story");
  assert.equal(safePublicCitationURL("http://example.org/story"), undefined);
  assert.equal(safePublicCitationURL("https://user:secret@example.org/story"), undefined);
});

test("private repositories and AI models can never become citable evidence", () => {
  assert.equal(validateResearchEvidence(evidence({ source: "outlook" })), false);
  assert.equal(validateResearchEvidence(evidence({ source: "chatgpt" })), false);
  assert.equal(validateResearchEvidence(evidence()), true);
});

test("citation must match an exact broker evidence id and URL", () => {
  const item = evidence();
  assert.deepEqual(validateOutboundResearchCitations([
    { evidenceId: item.id, label: item.title, hyperlink: item.publicURL },
  ], [item]), { allow: true });
  assert.equal(validateOutboundResearchCitations([
    { evidenceId: item.id, label: item.title, hyperlink: "https://attacker.example/" },
  ], [item]).allow, false);
});

test("configured is not healthy and duplicate capability authority fails closed", () => {
  const ready = { source: "outlook", state: "healthy", capabilityReference: "mcp:outlook.read" };
  assert.deepEqual(authorizeResearchSources(["outlook"], [ready]), { allow: true });
  assert.equal(authorizeResearchSources(["outlook"], [{ ...ready, state: "configured" }]).allow, false);
  assert.equal(authorizeResearchSources(["outlook"], [ready, ready]).allow, false);
});
