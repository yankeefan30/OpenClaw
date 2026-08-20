import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DailyPayloadSchema } from "../src/schemas/payload.ts";
import { scoreToHealthBand, trendArrow } from "../src/utils/scoreBands.ts";
import { computeReviewFlags } from "../src/utils/reviewFlags.ts";
import { mergeSkipBlank } from "../src/notion/properties.ts";
import { isRetryableNotionError } from "../src/utils/retry.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(
  __dirname,
  "../fixtures/sample-daily-payload.json",
);

describe("DailyPayloadSchema", () => {
  it("accepts the sample fixture", () => {
    const raw = JSON.parse(readFileSync(fixturePath, "utf8"));
    const parsed = DailyPayloadSchema.parse(raw);
    assert.equal(parsed.schema_version, "1.0.0");
    assert.equal(parsed.people.length, 3);
    assert.equal(parsed.evidence.length, 6);
    assert.ok(
      parsed.evidence.every((e) => e.redacted_evidence_snippet.length <= 500),
    );
  });

  it("rejects snippets over 500 characters", () => {
    const raw = JSON.parse(readFileSync(fixturePath, "utf8"));
    raw.evidence[0].redacted_evidence_snippet = "x".repeat(501);
    assert.throws(() => DailyPayloadSchema.parse(raw));
  });

  it("rejects missing run_id", () => {
    const raw = JSON.parse(readFileSync(fixturePath, "utf8"));
    delete raw.run_id;
    assert.throws(() => DailyPayloadSchema.parse(raw));
  });
});

describe("score bands", () => {
  it("maps bands correctly", () => {
    assert.equal(scoreToHealthBand(null), "Insufficient Evidence");
    assert.equal(scoreToHealthBand(85), "Strong");
    assert.equal(scoreToHealthBand(70), "Healthy");
    assert.equal(scoreToHealthBand(55), "Watch");
    assert.equal(scoreToHealthBand(54), "At Risk");
  });

  it("only shows trend arrows when delta exists", () => {
    assert.equal(trendArrow(undefined), "");
    assert.equal(trendArrow(null), "");
    assert.equal(trendArrow(3), "↑");
    assert.equal(trendArrow(-3), "↓");
    assert.equal(trendArrow(0.5), "→");
  });
});

describe("review flags", () => {
  it("flags overall delta > 10, tier1 < 60, high risk, low coverage", () => {
    const raw = JSON.parse(readFileSync(fixturePath, "utf8"));
    raw.overall_assessment.prior_day_score = 50;
    raw.overall_assessment.overall_score = 74;
    raw.source_coverage = 40;
    const payload = DailyPayloadSchema.parse(raw);
    const tiers = new Map([
      ["person:jordan-lee", "Tier 1"],
      ["person:sam-okonkwo", "Tier 1"],
    ]);
    const result = computeReviewFlags(payload, tiers);
    assert.equal(result.humanReviewRequired, true);
    const codes = result.flags.map((f) => f.code);
    assert.ok(codes.includes("overall_score_delta_gt_10"));
    assert.ok(codes.includes("tier1_score_lt_60"));
    assert.ok(codes.includes("high_or_critical_risk"));
    assert.ok(codes.includes("source_coverage_lt_60"));
  });
});

describe("mergeSkipBlank / protected fields", () => {
  it("does not overwrite non-empty protected fields with blanks", () => {
    const merged = mergeSkipBlank(
      {
        "Human Context Notes": { rich_text: [{ text: { content: "" } }] },
        "Organization / Function": {
          rich_text: [{ text: { content: "Product" } }],
        },
      },
      { "Human Context Notes": "Keep this human note" },
      ["Human Context Notes"],
    );
    assert.equal("Human Context Notes" in merged, false);
    assert.ok("Organization / Function" in merged);
  });
});

describe("retry classification", () => {
  it("retries 429 and 5xx", () => {
    assert.equal(isRetryableNotionError({ status: 429 }), true);
    assert.equal(isRetryableNotionError({ status: 500 }), true);
    assert.equal(isRetryableNotionError({ status: 400 }), false);
  });
});

describe("idempotency key patterns", () => {
  it("uses stable external keys in fixture", () => {
    const raw = JSON.parse(readFileSync(fixturePath, "utf8"));
    const payload = DailyPayloadSchema.parse(raw);
    assert.equal(
      `political-health:${payload.analysis_date}`,
      "political-health:2026-03-19",
    );
    for (const ra of payload.relationship_assessments) {
      assert.match(
        ra.external_key,
        /^relationship-assessment:person:.+:\d{4}-\d{2}-\d{2}$/,
      );
    }
  });
});

describe("relation linking contract", () => {
  it("evidence references interactions and people that exist in payload", () => {
    const payload = DailyPayloadSchema.parse(
      JSON.parse(readFileSync(fixturePath, "utf8")),
    );
    const people = new Set(payload.people.map((p) => p.external_key));
    const interactions = new Set(
      payload.interactions.map((i) => i.external_key),
    );
    for (const ev of payload.evidence) {
      for (const p of ev.related_people_external_keys) {
        assert.ok(people.has(p), `missing person ${p}`);
      }
      if (ev.interaction_external_key) {
        assert.ok(interactions.has(ev.interaction_external_key));
      }
    }
  });
});

describe("partial failure model", () => {
  it("keeps independent entity arrays so importer can continue after one failure", () => {
    const payload = DailyPayloadSchema.parse(
      JSON.parse(readFileSync(fixturePath, "utf8")),
    );
    // Simulate dropping one action — remaining payload still valid
    const reduced = {
      ...payload,
      actions: payload.actions.slice(0, 1),
    };
    const again = DailyPayloadSchema.parse(reduced);
    assert.equal(again.actions.length, 1);
    assert.equal(again.evidence.length, 6);
  });
});
