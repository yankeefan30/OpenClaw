import type {
  DailyPayload,
  RelationshipAssessmentInput,
  RiskOpportunityInput,
} from "../schemas/payload.ts";

export interface ComputedReviewFlags {
  humanReviewRequired: boolean;
  flags: Array<{ code: string; reason: string; severity: "info" | "warn" | "critical" }>;
}

/**
 * Applies automation review rules. Payload review_flags are merged in.
 */
export function computeReviewFlags(
  payload: DailyPayload,
  personTierByKey: Map<string, string | undefined>,
): ComputedReviewFlags {
  const flags = [...payload.review_flags];

  const overall = payload.overall_assessment;
  const prior = overall.prior_day_score;
  if (
    prior !== null &&
    prior !== undefined &&
    overall.overall_score !== null &&
    Math.abs(overall.overall_score - prior) > 10
  ) {
    flags.push({
      code: "overall_score_delta_gt_10",
      reason: `Overall score moved by ${Math.abs(overall.overall_score - prior)} points`,
      severity: "critical",
    });
  }

  if (payload.source_coverage < 60) {
    flags.push({
      code: "source_coverage_lt_60",
      reason: `Source coverage ${payload.source_coverage} < 60`,
      severity: "warn",
    });
  }

  if (overall.confidence < 55) {
    flags.push({
      code: "overall_confidence_lt_55",
      reason: `Overall confidence ${overall.confidence} < 55`,
      severity: "warn",
    });
  }

  for (const ra of payload.relationship_assessments) {
    flagTier1Low(ra, personTierByKey, flags);
    if (ra.confidence !== undefined && ra.confidence < 55 && isMaterialRelationship(ra, personTierByKey)) {
      flags.push({
        code: "material_confidence_lt_55",
        reason: `Relationship ${ra.person_external_key} confidence ${ra.confidence} < 55`,
        severity: "warn",
      });
    }
  }

  for (const risk of payload.risks_and_opportunities) {
    flagHighCriticalRisk(risk, flags);
  }

  for (const ev of payload.evidence) {
    if (ev.confidence < 55 && isMaterialClaimType(ev.claim_type)) {
      flags.push({
        code: "material_evidence_confidence_lt_55",
        reason: `Evidence ${ev.external_key} confidence ${ev.confidence} < 55`,
        severity: "warn",
      });
    }
  }

  const humanReviewRequired = flags.some(
    (f) => f.severity === "warn" || f.severity === "critical",
  );

  return { humanReviewRequired, flags };
}

function flagTier1Low(
  ra: RelationshipAssessmentInput,
  tiers: Map<string, string | undefined>,
  flags: ComputedReviewFlags["flags"],
) {
  const tier = tiers.get(ra.person_external_key);
  if (
    tier === "Tier 1" &&
    ra.daily_score !== null &&
    ra.daily_score !== undefined &&
    ra.daily_score < 60
  ) {
    flags.push({
      code: "tier1_score_lt_60",
      reason: `Tier 1 ${ra.person_external_key} score ${ra.daily_score} < 60`,
      severity: "critical",
    });
  }
}

function isMaterialRelationship(
  ra: RelationshipAssessmentInput,
  tiers: Map<string, string | undefined>,
): boolean {
  return tiers.get(ra.person_external_key) === "Tier 1";
}

function flagHighCriticalRisk(
  risk: RiskOpportunityInput,
  flags: ComputedReviewFlags["flags"],
) {
  if (risk.severity === "High" || risk.severity === "Critical") {
    flags.push({
      code: "high_or_critical_risk",
      reason: `${risk.severity} ${risk.type}: ${risk.title}`,
      severity: "critical",
    });
  }
}

function isMaterialClaimType(claimType: string): boolean {
  return [
    "Risk Signal",
    "Commitment",
    "Decision",
    "Sponsor Signal",
    "Conflict Signal",
    "Alignment Signal",
  ].includes(claimType);
}
