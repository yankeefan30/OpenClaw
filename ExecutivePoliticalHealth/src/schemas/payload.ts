import { z } from "zod";

/** Score 0–100 inclusive. */
export const ScoreSchema = z.number().min(0).max(100);

export const HealthBandSchema = z.enum([
  "Strong",
  "Healthy",
  "Watch",
  "At Risk",
  "Insufficient Evidence",
]);

export const TrendDirectionSchema = z.enum([
  "Improving",
  "Stable",
  "Declining",
  "Volatile",
  "Insufficient Data",
  "Unknown",
]);

export const SourceSystemSchema = z.enum([
  "Limitless",
  "Plaud",
  "Email",
  "Manual",
]);

export const DimensionSchema = z.enum([
  "Sponsor confidence",
  "Stakeholder alignment",
  "Relationship capital",
  "Influence and visibility",
  "Delivery credibility",
  "Organizational intelligence",
  "Conflict and risk management",
]);

export const ClaimTypeSchema = z.enum([
  "Positive Signal",
  "Risk Signal",
  "Commitment",
  "Decision",
  "Alignment Signal",
  "Sponsor Signal",
  "Visibility Signal",
  "Conflict Signal",
  "Follow-up Needed",
  "Context",
]);

const RichTextOptional = z.string().max(8000).optional();
const SnippetSchema = z
  .string()
  .max(500, "Redacted evidence snippet must be ≤500 characters");

export const PersonRefSchema = z.object({
  external_key: z.string().min(1),
  name: z.string().min(1),
  organization_function: z.string().optional(),
  role_title: z.string().optional(),
  relationship_type: z
    .array(
      z.enum([
        "Manager",
        "Direct Report",
        "Peer",
        "Executive Sponsor",
        "Key Partner",
        "Customer",
        "Vendor",
        "Board",
        "Other",
      ]),
    )
    .optional(),
  strategic_tier: z
    .enum(["Tier 1", "Tier 2", "Tier 3", "Monitor"])
    .optional(),
  influence_level: z.number().min(1).max(5).optional(),
  decision_proximity: z.number().min(1).max(5).optional(),
  /** Only applied on create or when existing value is empty. */
  relationship_objective: RichTextOptional,
  known_priorities: RichTextOptional,
  preferred_engagement_style: RichTextOptional,
  sensitivities_constraints: RichTextOptional,
  do_not_infer: RichTextOptional,
});

export const DimensionScoreInputSchema = z.object({
  external_key: z.string().min(1),
  dimension: DimensionSchema,
  weight: z.number().min(0).max(1).optional(),
  score: ScoreSchema.nullable().optional(),
  delta_vs_prior_day: z.number().nullable().optional(),
  trend: TrendDirectionSchema.optional(),
  confidence: ScoreSchema.optional(),
  evidence_summary: RichTextOptional,
  what_drove_change: RichTextOptional,
  recommended_action: RichTextOptional,
  evidence_external_keys: z.array(z.string()).default([]),
});

export const RelationshipAssessmentInputSchema = z.object({
  external_key: z.string().min(1),
  person_external_key: z.string().min(1),
  daily_score: ScoreSchema.nullable().optional(),
  score_delta: z.number().nullable().optional(),
  trend: TrendDirectionSchema.optional(),
  confidence: ScoreSchema.optional(),
  engagement_quality: ScoreSchema.nullable().optional(),
  trust_credibility: ScoreSchema.nullable().optional(),
  alignment: ScoreSchema.nullable().optional(),
  influence_sponsorship: ScoreSchema.nullable().optional(),
  responsiveness_reciprocity: ScoreSchema.nullable().optional(),
  risk_level: z.enum(["Low", "Moderate", "High", "Critical"]).optional(),
  readout: RichTextOptional,
  positive_signals: RichTextOptional,
  watch_outs: RichTextOptional,
  recommended_next_move: RichTextOptional,
  evidence_external_keys: z.array(z.string()).default([]),
  action_external_keys: z.array(z.string()).default([]),
});

export const InteractionInputSchema = z.object({
  external_key: z.string().min(1),
  title: z.string().min(1),
  interaction_datetime: z.string().datetime({ offset: true }).or(z.string().min(1)),
  source_system: SourceSystemSchema,
  source_reference: z.string().url().optional().or(z.literal("")),
  interaction_type: z.enum([
    "Meeting",
    "Email Thread",
    "One-to-One",
    "Decision",
    "Escalation",
    "Informal Conversation",
    "Manual Note",
  ]),
  participant_external_keys: z.array(z.string()).default([]),
  topics: z.array(z.string()).default([]),
  organizational_relevance: z
    .enum(["Low", "Medium", "High", "Critical"])
    .optional(),
  summary: RichTextOptional,
  key_decisions: RichTextOptional,
  commitments: RichTextOptional,
  sentiment_tone: z
    .enum(["Constructive", "Neutral", "Tense", "Mixed", "Unknown"])
    .optional(),
  evidence_quality: z
    .enum(["Direct", "Strong Inference", "Weak Inference"])
    .optional(),
  raw_content_location: z.string().url().optional().or(z.literal("")),
  included_in_analysis: z.boolean().default(true),
});

export const EvidenceInputSchema = z.object({
  external_key: z.string().min(1),
  title: z.string().min(1),
  event_datetime: z.string().min(1),
  source_system: SourceSystemSchema,
  source_reference: z.string().url().optional().or(z.literal("")),
  interaction_external_key: z.string().optional(),
  related_people_external_keys: z.array(z.string()).default([]),
  related_relationship_assessment_external_key: z.string().optional(),
  related_dimension_score_external_key: z.string().optional(),
  claim_type: ClaimTypeSchema,
  redacted_evidence_snippet: SnippetSchema,
  analyst_interpretation: RichTextOptional,
  confidence: ScoreSchema,
  verification_status: z
    .enum(["Unverified", "Corroborated", "Human Confirmed", "Disputed"])
    .default("Unverified"),
  sensitive_content_flag: z.boolean().default(false),
  excluded_reason: RichTextOptional,
});

export const RiskOpportunityInputSchema = z.object({
  external_key: z.string().min(1),
  title: z.string().min(1),
  type: z.enum([
    "Risk",
    "Opportunity",
    "Decision Window",
    "Relationship Exposure",
  ]),
  status: z
    .enum(["Open", "Monitoring", "Mitigating", "Closed", "Invalidated"])
    .default("Open"),
  severity: z.enum(["Low", "Moderate", "High", "Critical"]),
  likelihood: z.enum(["Low", "Medium", "High"]).optional(),
  strategic_impact: z.number().min(1).max(5).optional(),
  related_people_external_keys: z.array(z.string()).default([]),
  evidence_external_keys: z.array(z.string()).default([]),
  narrative: RichTextOptional,
  trigger_signal: RichTextOptional,
  mitigation_or_capture_plan: RichTextOptional,
  owner: z.string().optional(),
  due_date: z.string().optional(),
});

export const ActionInputSchema = z.object({
  external_key: z.string().min(1),
  title: z.string().min(1),
  action_type: z.enum([
    "Follow up",
    "Schedule one-to-one",
    "Clarify ownership",
    "Provide update",
    "Acknowledge contribution",
    "Seek input",
    "Escalate constructively",
    "Repair relationship",
    "Increase visibility",
    "Validate assumption",
    "Other",
  ]),
  priority: z.enum(["P0", "P1", "P2", "P3"]).default("P2"),
  status: z
    .enum(["Suggested", "Accepted", "In Progress", "Done", "Declined"])
    .default("Suggested"),
  due_date: z.string().optional(),
  why_now: RichTextOptional,
  suggested_language: RichTextOptional,
  related_person_external_key: z.string().optional(),
  related_risk_external_key: z.string().optional(),
  related_evidence_external_keys: z.array(z.string()).default([]),
  human_approval_required: z.boolean().default(false),
});

export const OverallAssessmentSchema = z.object({
  overall_score: ScoreSchema.nullable(),
  health_band: HealthBandSchema,
  prior_day_score: ScoreSchema.nullable().optional(),
  seven_day_trend_delta: z.number().nullable().optional(),
  thirty_day_trend_delta: z.number().nullable().optional(),
  trend_direction: TrendDirectionSchema.optional(),
  confidence: ScoreSchema,
  evidence_count: z.number().int().min(0).default(0),
  executive_readout: z.string().min(1).max(2000),
  what_changed: RichTextOptional,
  key_wins: RichTextOptional,
  key_risks: RichTextOptional,
  top_actions: RichTextOptional,
  signals_to_verify: RichTextOptional,
});

export const ReviewFlagSchema = z.object({
  code: z.string(),
  reason: z.string(),
  severity: z.enum(["info", "warn", "critical"]).default("warn"),
});

export const DailyPayloadSchema = z.object({
  schema_version: z.literal("1.0.0"),
  run_id: z.string().min(1),
  analysis_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "analysis_date must be YYYY-MM-DD"),
  data_window: z.object({
    start: z.string().min(1),
    end: z.string().min(1),
  }),
  source_coverage: ScoreSchema,
  overall_assessment: OverallAssessmentSchema,
  people: z.array(PersonRefSchema).default([]),
  dimension_scores: z.array(DimensionScoreInputSchema).default([]),
  relationship_assessments: z
    .array(RelationshipAssessmentInputSchema)
    .default([]),
  interactions: z.array(InteractionInputSchema).default([]),
  evidence: z.array(EvidenceInputSchema).default([]),
  risks_and_opportunities: z.array(RiskOpportunityInputSchema).default([]),
  actions: z.array(ActionInputSchema).default([]),
  review_flags: z.array(ReviewFlagSchema).default([]),
  analysis_metadata: z.object({
    analyst_version: z.string().min(1),
    claude_model_or_skill_version: z.string().min(1),
    analysis_timestamp: z.string().min(1),
    timezone: z.literal("America/New_York").default("America/New_York"),
    inputs_received: z.number().int().min(0).default(0),
    inputs_excluded: z.number().int().min(0).default(0),
  }),
});

export type DailyPayload = z.infer<typeof DailyPayloadSchema>;
export type PersonRef = z.infer<typeof PersonRefSchema>;
export type EvidenceInput = z.infer<typeof EvidenceInputSchema>;
export type RelationshipAssessmentInput = z.infer<
  typeof RelationshipAssessmentInputSchema
>;
export type RiskOpportunityInput = z.infer<typeof RiskOpportunityInputSchema>;
