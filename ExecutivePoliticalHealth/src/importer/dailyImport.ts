import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import type { AppConfig } from "../config/env.ts";
import type { DailyPayload } from "../schemas/payload.ts";
import { DailyPayloadSchema } from "../schemas/payload.ts";
import { Logger } from "../utils/logger.ts";
import { computeReviewFlags } from "../utils/reviewFlags.ts";
import { scoreToHealthBand } from "../utils/scoreBands.ts";
import {
  PROTECTED_RELATIONSHIP_PROPS,
  checkbox,
  dateProp,
  getRichText,
  getSelectName,
  multiSelect,
  numberProp,
  relation,
  richText,
  select,
  title,
  urlProp,
} from "../notion/properties.ts";
import {
  NotionWriter,
  databasesFromConfig,
  type NotionDatabases,
} from "../notion/upsert.ts";

export interface ImportResult {
  runId: string;
  analysisDate: string;
  status: "Succeeded" | "Partial" | "Failed" | "Needs Review";
  created: number;
  updated: number;
  errors: string[];
  humanReviewRequired: boolean;
  pageIds: Record<string, string>;
}

export async function importDailyPayload(
  raw: unknown,
  cfg: AppConfig,
  log = new Logger(cfg.LOG_LEVEL),
): Promise<ImportResult> {
  const payload = DailyPayloadSchema.parse(raw);
  const dbs = databasesFromConfig(cfg);
  const writer = new NotionWriter(cfg, log);
  const errors: string[] = [];
  let created = 0;
  let updated = 0;
  const pageIds: Record<string, string> = {};

  const personTier = new Map<string, string | undefined>();
  for (const p of payload.people) {
    personTier.set(p.external_key, p.strategic_tier);
  }

  const nowIso = new Date().toISOString();
  const analysisDate = payload.analysis_date;
  const dailyKey = `political-health:${analysisDate}`;

  // 0) Analysis run — Started
  try {
    const run = await writer.upsertByExternalKey({
      databaseId: dbs.analysisRuns,
      externalKey: `run:${payload.run_id}`,
      properties: {
        Title: title(`Run — ${analysisDate} ${payload.run_id.slice(0, 8)}`),
        "External Key": richText(`run:${payload.run_id}`)!,
        "Run ID": richText(payload.run_id)!,
        "Schedule Time": dateProp(payload.analysis_metadata.analysis_timestamp, {
          datetime: true,
        })!,
        Status: select("Started")!,
        "Source Coverage": numberProp(payload.source_coverage)!,
        "Inputs Received": numberProp(
          payload.analysis_metadata.inputs_received,
        )!,
        "Inputs Excluded": numberProp(
          payload.analysis_metadata.inputs_excluded,
        )!,
        "Claude Model / Skill Version": richText(
          payload.analysis_metadata.claude_model_or_skill_version,
        )!,
        "Analyst Version": richText(
          payload.analysis_metadata.analyst_version,
        )!,
        "Notion Write Status": richText("started")!,
        "Last Automated Update": dateProp(nowIso, { datetime: true })!,
      },
    });
    pageIds.analysisRun = run.pageId;
    run.created ? created++ : updated++;
  } catch (err) {
    errors.push(`analysis_run_start: ${String((err as Error).message ?? err)}`);
  }

  // 1) People
  for (const person of payload.people) {
    try {
      const existing = await writer.findByExternalKey(
        dbs.strategicRelationships,
        person.external_key,
      );
      const props = buildPersonProperties(person, existing, nowIso);
      const res = await writer.upsertByExternalKey({
        databaseId: dbs.strategicRelationships,
        externalKey: person.external_key,
        properties: props as never,
      });
      pageIds[`person:${person.external_key}`] = res.pageId;
      res.created ? created++ : updated++;
      if (!person.strategic_tier && existing) {
        personTier.set(
          person.external_key,
          getSelectName(existing, "Strategic Tier") ?? undefined,
        );
      }
    } catch (err) {
      errors.push(
        `person:${person.external_key}: ${String((err as Error).message ?? err)}`,
      );
    }
  }

  // Recompute review with resolved tiers
  const reviewFinal = computeReviewFlags(payload, personTier);

  // 2) Interactions
  for (const ix of payload.interactions) {
    try {
      const participantIds = await mapKeys(
        writer,
        dbs.strategicRelationships,
        ix.participant_external_keys,
      );
      const res = await writer.upsertByExternalKey({
        databaseId: dbs.interactions,
        externalKey: ix.external_key,
        properties: {
          Title: title(ix.title),
          "External Key": richText(ix.external_key)!,
          "Interaction DateTime": dateProp(ix.interaction_datetime, {
            datetime: true,
          })!,
          "Source System": select(ix.source_system)!,
          "Source Reference": urlProp(ix.source_reference || null)!,
          "Interaction Type": select(ix.interaction_type)!,
          Participants: relation(participantIds)!,
          Topics: multiSelect(ix.topics)!,
          "Organizational Relevance": select(ix.organizational_relevance)!,
          Summary: richText(ix.summary)!,
          "Key Decisions": richText(ix.key_decisions)!,
          Commitments: richText(ix.commitments)!,
          "Sentiment / Tone": select(ix.sentiment_tone)!,
          "Evidence Quality": select(ix.evidence_quality)!,
          "Raw Content Location": urlProp(ix.raw_content_location || null)!,
          "Included in Analysis": checkbox(ix.included_in_analysis)!,
          "Analyst Version": richText(
            payload.analysis_metadata.analyst_version,
          )!,
          "Run ID": richText(payload.run_id)!,
          "Last Automated Update": dateProp(nowIso, { datetime: true })!,
        },
      });
      pageIds[`interaction:${ix.external_key}`] = res.pageId;
      res.created ? created++ : updated++;
    } catch (err) {
      errors.push(
        `interaction:${ix.external_key}: ${String((err as Error).message ?? err)}`,
      );
    }
  }

  // 3) Evidence
  for (const ev of payload.evidence) {
    try {
      const peopleIds = await mapKeys(
        writer,
        dbs.strategicRelationships,
        ev.related_people_external_keys,
      );
      const interactionId = ev.interaction_external_key
        ? await writer.resolveId(dbs.interactions, ev.interaction_external_key)
        : null;
      const res = await writer.upsertByExternalKey({
        databaseId: dbs.evidenceLedger,
        externalKey: ev.external_key,
        properties: {
          Title: title(ev.title),
          "External Key": richText(ev.external_key)!,
          "Event DateTime": dateProp(ev.event_datetime, { datetime: true })!,
          "Source System": select(ev.source_system)!,
          "Source Reference": urlProp(ev.source_reference || null)!,
          Interaction: relation(interactionId ? [interactionId] : [])!,
          "Related People": relation(peopleIds)!,
          "Claim Type": select(ev.claim_type)!,
          "Redacted Evidence Snippet": richText(ev.redacted_evidence_snippet)!,
          "Analyst Interpretation": richText(ev.analyst_interpretation)!,
          Confidence: numberProp(ev.confidence)!,
          "Verification Status": select(ev.verification_status)!,
          "Sensitive Content Flag": checkbox(ev.sensitive_content_flag)!,
          "Excluded Reason": richText(ev.excluded_reason)!,
          "Analyst Version": richText(
            payload.analysis_metadata.analyst_version,
          )!,
          "Run ID": richText(payload.run_id)!,
          "Last Automated Update": dateProp(nowIso, { datetime: true })!,
        },
      });
      pageIds[`evidence:${ev.external_key}`] = res.pageId;
      res.created ? created++ : updated++;
    } catch (err) {
      errors.push(
        `evidence:${ev.external_key}: ${String((err as Error).message ?? err)}`,
      );
    }
  }

  // 4) Daily assessment
  const oa = payload.overall_assessment;
  const healthBand =
    oa.health_band || scoreToHealthBand(oa.overall_score ?? null);
  let dailyAssessmentId: string | null = null;
  try {
    const res = await writer.upsertByExternalKey({
      databaseId: dbs.dailyAssessments,
      externalKey: dailyKey,
      properties: {
        Name: title(`Political Health — ${analysisDate}`),
        "External Key": richText(dailyKey)!,
        "Assessment Date": dateProp(analysisDate)!,
        "Overall Score": numberProp(oa.overall_score)!,
        "Health Band": select(healthBand)!,
        "Prior Day Score": numberProp(oa.prior_day_score ?? null)!,
        "7-Day Trend Delta": numberProp(oa.seven_day_trend_delta ?? null)!,
        "30-Day Trend Delta": numberProp(oa.thirty_day_trend_delta ?? null)!,
        "Trend Direction": select(oa.trend_direction)!,
        Confidence: numberProp(oa.confidence)!,
        "Source Coverage": numberProp(payload.source_coverage)!,
        "Evidence Count": numberProp(oa.evidence_count)!,
        "Executive Readout": richText(oa.executive_readout)!,
        "What Changed": richText(oa.what_changed)!,
        "Key Wins": richText(oa.key_wins)!,
        "Key Risks": richText(oa.key_risks)!,
        "Top Actions": richText(oa.top_actions)!,
        "Signals to Verify": richText(oa.signals_to_verify)!,
        "Human Review Required": checkbox(reviewFinal.humanReviewRequired)!,
        "Human Review Status": select(
          reviewFinal.humanReviewRequired ? "Pending" : "Not Required",
        )!,
        "Analyst Version": richText(
          payload.analysis_metadata.analyst_version,
        )!,
        "Run ID": richText(payload.run_id)!,
        "Analysis Timestamp": dateProp(
          payload.analysis_metadata.analysis_timestamp,
          { datetime: true },
        )!,
        "Data Window Start": dateProp(payload.data_window.start, {
          datetime: true,
        })!,
        "Data Window End": dateProp(payload.data_window.end, {
          datetime: true,
        })!,
        "Last Automated Update": dateProp(nowIso, { datetime: true })!,
      },
    });
    dailyAssessmentId = res.pageId;
    pageIds.dailyAssessment = res.pageId;
    res.created ? created++ : updated++;
  } catch (err) {
    errors.push(`daily_assessment: ${String((err as Error).message ?? err)}`);
  }

  // 5) Dimension scores
  const dimensionIds: string[] = [];
  for (const dim of payload.dimension_scores) {
    try {
      const evidenceIds = await mapKeys(
        writer,
        dbs.evidenceLedger,
        dim.evidence_external_keys,
      );
      const res = await writer.upsertByExternalKey({
        databaseId: dbs.dimensionScores,
        externalKey: dim.external_key,
        properties: {
          Title: title(`${dim.dimension} — ${analysisDate}`),
          "External Key": richText(dim.external_key)!,
          "Assessment Date": dateProp(analysisDate)!,
          Dimension: select(dim.dimension)!,
          Weight: numberProp(dim.weight ?? null)!,
          Score: numberProp(dim.score ?? null)!,
          "Delta vs Prior Day": numberProp(dim.delta_vs_prior_day ?? null)!,
          Trend: select(dim.trend)!,
          Confidence: numberProp(dim.confidence ?? null)!,
          "Evidence Summary": richText(dim.evidence_summary)!,
          "What Drove Change": richText(dim.what_drove_change)!,
          "Recommended Action": richText(dim.recommended_action)!,
          "Daily Assessment": relation(
            dailyAssessmentId ? [dailyAssessmentId] : [],
          )!,
          Evidence: relation(evidenceIds)!,
          "Analyst Version": richText(
            payload.analysis_metadata.analyst_version,
          )!,
          "Run ID": richText(payload.run_id)!,
          "Last Automated Update": dateProp(nowIso, { datetime: true })!,
        },
      });
      dimensionIds.push(res.pageId);
      pageIds[`dimension:${dim.external_key}`] = res.pageId;
      res.created ? created++ : updated++;
    } catch (err) {
      errors.push(
        `dimension:${dim.external_key}: ${String((err as Error).message ?? err)}`,
      );
    }
  }

  // 6) Relationship assessments + sync parent health
  const relAssessmentIds: string[] = [];
  for (const ra of payload.relationship_assessments) {
    try {
      const personId = await writer.resolveId(
        dbs.strategicRelationships,
        ra.person_external_key,
      );
      const evidenceIds = await mapKeys(
        writer,
        dbs.evidenceLedger,
        ra.evidence_external_keys,
      );
      const tier1Low =
        personTier.get(ra.person_external_key) === "Tier 1" &&
        ra.daily_score !== null &&
        ra.daily_score !== undefined &&
        ra.daily_score < 60;
      const res = await writer.upsertByExternalKey({
        databaseId: dbs.relationshipDailyAssessments,
        externalKey: ra.external_key,
        properties: {
          Title: title(
            `${ra.person_external_key.replace(/^person:/, "")} — ${analysisDate}`,
          ),
          "External Key": richText(ra.external_key)!,
          "Assessment Date": dateProp(analysisDate)!,
          Relationship: relation(personId ? [personId] : [])!,
          "Daily Score": numberProp(ra.daily_score ?? null)!,
          "Score Delta": numberProp(ra.score_delta ?? null)!,
          Trend: select(ra.trend)!,
          Confidence: numberProp(ra.confidence ?? null)!,
          "Engagement Quality": numberProp(ra.engagement_quality ?? null)!,
          "Trust / Credibility": numberProp(ra.trust_credibility ?? null)!,
          Alignment: numberProp(ra.alignment ?? null)!,
          "Influence / Sponsorship": numberProp(
            ra.influence_sponsorship ?? null,
          )!,
          "Responsiveness / Reciprocity": numberProp(
            ra.responsiveness_reciprocity ?? null,
          )!,
          "Risk Level": select(ra.risk_level)!,
          Readout: richText(ra.readout)!,
          "Positive Signals": richText(ra.positive_signals)!,
          "Watch-outs": richText(ra.watch_outs)!,
          "Recommended Next Move": richText(ra.recommended_next_move)!,
          "Human Review Required": checkbox(tier1Low || reviewFinal.humanReviewRequired)!,
          "Daily Assessment": relation(
            dailyAssessmentId ? [dailyAssessmentId] : [],
          )!,
          Evidence: relation(evidenceIds)!,
          "Analyst Version": richText(
            payload.analysis_metadata.analyst_version,
          )!,
          "Run ID": richText(payload.run_id)!,
          "Last Automated Update": dateProp(nowIso, { datetime: true })!,
        },
      });
      relAssessmentIds.push(res.pageId);
      pageIds[`rel:${ra.external_key}`] = res.pageId;
      res.created ? created++ : updated++;

      if (personId && ra.daily_score !== null && ra.daily_score !== undefined) {
        // Health metrics only — never rewrite Name or protected human fields.
        await writer.updateProperties(personId, {
          "Current Relationship Health": numberProp(ra.daily_score)!,
          "7-Day Trend": numberProp(ra.score_delta ?? null)!,
          "Last Automated Update": dateProp(nowIso, { datetime: true })!,
        });
      }
    } catch (err) {
      errors.push(
        `rel_assessment:${ra.external_key}: ${String((err as Error).message ?? err)}`,
      );
    }
  }

  // 7) Risks
  const riskIds: string[] = [];
  for (const risk of payload.risks_and_opportunities) {
    try {
      const peopleIds = await mapKeys(
        writer,
        dbs.strategicRelationships,
        risk.related_people_external_keys,
      );
      const evidenceIds = await mapKeys(
        writer,
        dbs.evidenceLedger,
        risk.evidence_external_keys,
      );
      const needsReview =
        risk.severity === "High" || risk.severity === "Critical";
      const res = await writer.upsertByExternalKey({
        databaseId: dbs.risksOpportunities,
        externalKey: risk.external_key,
        properties: {
          Title: title(risk.title),
          "External Key": richText(risk.external_key)!,
          Type: select(risk.type)!,
          Status: select(risk.status)!,
          Severity: select(risk.severity)!,
          Likelihood: select(risk.likelihood)!,
          "Strategic Impact": numberProp(risk.strategic_impact ?? null)!,
          "Related People": relation(peopleIds)!,
          "Related Daily Assessment": relation(
            dailyAssessmentId ? [dailyAssessmentId] : [],
          )!,
          Evidence: relation(evidenceIds)!,
          Narrative: richText(risk.narrative)!,
          "Trigger / Signal": richText(risk.trigger_signal)!,
          "Mitigation or Capture Plan": richText(
            risk.mitigation_or_capture_plan,
          )!,
          Owner: richText(risk.owner)!,
          "Due Date": dateProp(risk.due_date)!,
          "Human Review Required": checkbox(needsReview)!,
          "Analyst Version": richText(
            payload.analysis_metadata.analyst_version,
          )!,
          "Run ID": richText(payload.run_id)!,
          "Last Automated Update": dateProp(nowIso, { datetime: true })!,
        },
      });
      riskIds.push(res.pageId);
      pageIds[`risk:${risk.external_key}`] = res.pageId;
      res.created ? created++ : updated++;
    } catch (err) {
      errors.push(
        `risk:${risk.external_key}: ${String((err as Error).message ?? err)}`,
      );
    }
  }

  // 8) Actions
  const actionIds: string[] = [];
  for (const action of payload.actions) {
    try {
      const existing = await writer.findByExternalKey(
        dbs.actions,
        action.external_key,
      );
      const existingStatus = existing
        ? getSelectName(existing, "Status")
        : null;
      // Do not overwrite human-owned status after Suggested
      const statusToWrite =
        existingStatus && existingStatus !== "Suggested"
          ? existingStatus
          : action.status;

      const personId = action.related_person_external_key
        ? await writer.resolveId(
            dbs.strategicRelationships,
            action.related_person_external_key,
          )
        : null;
      const riskId = action.related_risk_external_key
        ? await writer.resolveId(
            dbs.risksOpportunities,
            action.related_risk_external_key,
          )
        : null;
      const evidenceIds = await mapKeys(
        writer,
        dbs.evidenceLedger,
        action.related_evidence_external_keys,
      );

      const props: Record<string, unknown> = {
        Title: title(action.title),
        "External Key": richText(action.external_key)!,
        "Action Type": select(action.action_type)!,
        Priority: select(action.priority)!,
        Status: select(statusToWrite)!,
        "Due Date": dateProp(action.due_date)!,
        "Related Person": relation(personId ? [personId] : [])!,
        "Related Daily Assessment": relation(
          dailyAssessmentId ? [dailyAssessmentId] : [],
        )!,
        "Related Risk / Opportunity": relation(riskId ? [riskId] : [])!,
        "Related Evidence": relation(evidenceIds)!,
        "Human Approval Required": checkbox(action.human_approval_required)!,
        "Analyst Version": richText(
          payload.analysis_metadata.analyst_version,
        )!,
        "Run ID": richText(payload.run_id)!,
        "Last Automated Update": dateProp(nowIso, { datetime: true })!,
      };

      // Only refresh guidance text while Suggested
      if (!existingStatus || existingStatus === "Suggested") {
        props["Why Now"] = richText(action.why_now)!;
        props["Suggested Language"] = richText(action.suggested_language)!;
      }

      const res = await writer.upsertByExternalKey({
        databaseId: dbs.actions,
        externalKey: action.external_key,
        properties: props as never,
      });
      actionIds.push(res.pageId);
      pageIds[`action:${action.external_key}`] = res.pageId;
      res.created ? created++ : updated++;
    } catch (err) {
      errors.push(
        `action:${action.external_key}: ${String((err as Error).message ?? err)}`,
      );
    }
  }

  // 9) Link daily assessment aggregates
  if (dailyAssessmentId) {
    try {
      const evidenceIds = await mapKeys(
        writer,
        dbs.evidenceLedger,
        payload.evidence.map((e) => e.external_key),
      );
      await writer.updateRelations(dailyAssessmentId, {
        "Relationship Assessments": relAssessmentIds,
        "Political Risks": riskIds,
        "Recommended Actions": actionIds,
        Evidence: evidenceIds,
        "Dimension Scores": dimensionIds,
      });
    } catch (err) {
      errors.push(
        `daily_relations: ${String((err as Error).message ?? err)}`,
      );
    }
  }

  // 10) Finalize analysis run
  const status: ImportResult["status"] =
    errors.length === 0
      ? reviewFinal.humanReviewRequired
        ? "Needs Review"
        : "Succeeded"
      : created + updated > 0
        ? "Partial"
        : "Failed";

  try {
    await writer.upsertByExternalKey({
      databaseId: dbs.analysisRuns,
      externalKey: `run:${payload.run_id}`,
      properties: {
        Title: title(`Run — ${analysisDate} ${payload.run_id.slice(0, 8)}`),
        "External Key": richText(`run:${payload.run_id}`)!,
        "Run ID": richText(payload.run_id)!,
        Status: select(status)!,
        "Notion Write Status": richText(
          `created=${created}; updated=${updated}; errors=${errors.length}`,
        )!,
        "Error Detail": richText(
          errors.length ? errors.slice(0, 20).join("\n") : "",
        )!,
        "Daily Assessment": relation(
          dailyAssessmentId ? [dailyAssessmentId] : [],
        )!,
        "Last Automated Update": dateProp(nowIso, { datetime: true })!,
        "Source Coverage": numberProp(payload.source_coverage)!,
        "Inputs Received": numberProp(
          payload.analysis_metadata.inputs_received,
        )!,
        "Inputs Excluded": numberProp(
          payload.analysis_metadata.inputs_excluded,
        )!,
        "Claude Model / Skill Version": richText(
          payload.analysis_metadata.claude_model_or_skill_version,
        )!,
        "Analyst Version": richText(
          payload.analysis_metadata.analyst_version,
        )!,
        "Schedule Time": dateProp(payload.analysis_metadata.analysis_timestamp, {
          datetime: true,
        })!,
      },
    });
  } catch (err) {
    errors.push(`analysis_run_finish: ${String((err as Error).message ?? err)}`);
  }

  log.info("import complete", {
    runId: payload.run_id,
    status,
    created,
    updated,
    errorCount: errors.length,
    humanReviewRequired: reviewFinal.humanReviewRequired,
    flagCount: reviewFinal.flags.length,
  });

  return {
    runId: payload.run_id,
    analysisDate,
    status,
    created,
    updated,
    errors,
    humanReviewRequired: reviewFinal.humanReviewRequired,
    pageIds,
  };
}

async function mapKeys(
  writer: NotionWriter,
  databaseId: string,
  keys: string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const key of keys) {
    const id = await writer.resolveId(databaseId, key);
    if (id) ids.push(id);
  }
  return ids;
}

function buildPersonProperties(
  person: DailyPayload["people"][number],
  existing: PageObjectResponse | null,
  nowIso: string,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    Name: title(person.name),
    "External Key": richText(person.external_key)!,
    "Organization / Function": richText(person.organization_function)!,
    "Role / Title": richText(person.role_title)!,
    "Last Automated Update": dateProp(nowIso, { datetime: true })!,
  };

  // Only set identity/taxonomy fields when empty on existing or on create
  const setIfEmpty = (propName: string, value: unknown, existingText: string) => {
    if (!existing || !existingText.trim()) {
      base[propName] = value;
    }
  };

  if (person.relationship_type?.length) {
    setIfEmpty(
      "Relationship Type",
      multiSelect(person.relationship_type)!,
      existing ? getRichText(existing, "Relationship Type") : "",
    );
    if (!existing) base["Relationship Type"] = multiSelect(person.relationship_type)!;
    else if (!getSelectName(existing, "Strategic Tier") && !existing.properties["Relationship Type"]) {
      base["Relationship Type"] = multiSelect(person.relationship_type)!;
    } else if (existing) {
      const rt = existing.properties["Relationship Type"];
      const empty =
        !rt ||
        (rt.type === "multi_select" && rt.multi_select.length === 0);
      if (empty) base["Relationship Type"] = multiSelect(person.relationship_type)!;
    }
  }

  if (person.strategic_tier) {
    if (!existing || !getSelectName(existing, "Strategic Tier")) {
      base["Strategic Tier"] = select(person.strategic_tier)!;
    }
  }
  if (person.influence_level !== undefined) {
    base["Influence Level"] = numberProp(person.influence_level)!;
  }
  if (person.decision_proximity !== undefined) {
    base["Decision Proximity"] = numberProp(person.decision_proximity)!;
  }

  // Protected rich text: only seed when empty
  const seedProtected: Array<[string, string | undefined]> = [
    ["Relationship Objective", person.relationship_objective],
    ["Known Priorities", person.known_priorities],
    ["Preferred Engagement Style", person.preferred_engagement_style],
    ["Sensitivities / Constraints", person.sensitivities_constraints],
    ["Do Not Infer", person.do_not_infer],
  ];
  for (const [prop, value] of seedProtected) {
    if (!value) continue;
    const existingVal = existing ? getRichText(existing, prop) : "";
    if (!existingVal.trim()) {
      base[prop] = richText(value)!;
    }
  }

  // Ensure we never include protected keys for overwrite accidentally
  for (const p of PROTECTED_RELATIONSHIP_PROPS) {
    if (
      existing &&
      getRichText(existing, p).trim() &&
      p !== "Relationship Owner" &&
      p !== "Next Intended Touchpoint"
    ) {
      // already handled via seed-only
    }
  }

  return base;
}

export function validatePayload(raw: unknown): DailyPayload {
  return DailyPayloadSchema.parse(raw);
}

export type { NotionDatabases };
