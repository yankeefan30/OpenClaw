import type { HealthBandSchema } from "../schemas/payload.ts";
import type { z } from "zod";

export type HealthBand = z.infer<typeof HealthBandSchema>;

/** Display-only band from Claude composite score. Does not recompute weightings. */
export function scoreToHealthBand(score: number | null | undefined): HealthBand {
  if (score === null || score === undefined || Number.isNaN(score)) {
    return "Insufficient Evidence";
  }
  if (score >= 85) return "Strong";
  if (score >= 70) return "Healthy";
  if (score >= 55) return "Watch";
  return "At Risk";
}

export function trendArrow(delta: number | null | undefined): string {
  if (delta === null || delta === undefined || Number.isNaN(delta)) return "";
  if (delta > 1) return "↑";
  if (delta < -1) return "↓";
  return "→";
}

export function dimensionSlug(dimension: string): string {
  return dimension
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
