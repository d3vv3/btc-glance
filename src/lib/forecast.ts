import { z } from "zod";
import type { Bucket, Diagnostic, Forecast, ForecastSummary, Operator, ThresholdResult } from "./types";

export const BOUNDARY_CAVEAT = "Whole-bin membership only: above includes bins starting at the boundary; below includes bins ending there. Exact settlement equality and prices outside the offered support are not established. Quote shares are not calibrated probabilities. Captured time measures retrieval freshness, not the time of the last trade.";
export const QUOTE_SCALE_CAVEAT = "YES quote / total YES quotes. Quotes may exceed100; normalization is relative market quote weight, not independently validated odds.";
export const quoteSchema = z.object({
  topic_id: z.number().int().positive(), batch_id: z.string(), title: z.string(),
  market_end_time_utc: z.number().int().positive(), is_resolved: z.boolean(),
  outcomes: z.array(z.object({ option_id: z.number().int().positive(), name: z.string(), yes_price: z.number().finite(), no_price: z.number().finite() })).min(2),
}).passthrough();
export type QuotePayload = z.infer<typeof quoteSchema>;
export type ConversionResult = { buckets: Bucket[]; originalYesSum: number; normalizationFactor: number; diagnostics: Diagnostic[] };

export function convertQuotes(raw: unknown, expectedCount?: number): ConversionResult {
  const parsed = quoteSchema.safeParse(raw);
  const diagnostics: Diagnostic[] = [];
  const fail = (code: string, message: string) => diagnostics.push({ code, message });
  if (!parsed.success) return { buckets: [], originalYesSum: 0, normalizationFactor: 1, diagnostics: [{ code: "schema", message: parsed.error.message }] };
  const q = parsed.data;
  if (q.is_resolved) fail("resolved", "Resolved quotes cannot become prospective forecasts.");
  if (expectedCount !== undefined && q.outcomes.length !== expectedCount) fail("coverage", "Quote count does not match discovered market outcomes.");
  const ids = new Set<number>();
  const bins: Bucket[] = [];
  for (const o of q.outcomes) {
    if (ids.has(o.option_id)) fail("duplicate", `Duplicate option ${o.option_id}`);
    ids.add(o.option_id);
    if (o.yes_price < 0 || o.no_price < 0) fail("negative-quote", `Option ${o.option_id} has a negative YES or NO quote`);
    const match = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/.exec(o.name);
    if (!match) { fail("bin-label", `Unrecognized bin ${o.name}`); continue; }
    const lower = Number(match[1]), upper = Number(match[2]);
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || upper <= lower) fail("bin-range", `Invalid bin ${o.name}`);
    bins.push({ optionId: o.option_id, label: o.name, lower, upper, yes: o.yes_price, no: o.no_price, probability: 0, quoteShare: 0 });
  }
  bins.sort((a, b) => a.lower - b.lower);
  for (let i = 1; i < bins.length; i++) if (bins[i - 1].upper !== bins[i].lower) fail("contiguity", "Bins have gaps or overlaps.");
  const originalYesSum = q.outcomes.reduce((sum, o) => sum + o.yes_price, 0);
  if (!Number.isFinite(originalYesSum)) fail("numeric-overflow", "Total YES quotes cannot be represented as a finite number.");
  else if (originalYesSum === 0) fail("zero-total", "Total YES quotes must be positive.");
  const normalizationFactor = originalYesSum > 0 ? 100 / originalYesSum : 1;
  if (!Number.isFinite(normalizationFactor)) fail("numeric-representability", "100 / total YES quotes cannot be represented as a finite normalization factor.");
  // Direct division avoids intermediate underflow from raw YES / 100.
  if (!diagnostics.length) for (const b of bins) { b.quoteShare = b.yes / originalYesSum; b.probability = b.quoteShare; }
  return { buckets: diagnostics.length ? [] : bins, originalYesSum, normalizationFactor, diagnostics };
}

// Central intervals retain whole bins: an exact lower CDF boundary advances to
// the next positive bin, while the upper boundary includes its containing bin.
export function centralInterval(buckets: Bucket[], nominal: number) {
  let cumulative = 0, low = 0, high = buckets.length - 1;
  let foundLow = false;
  for (let i = 0; i < buckets.length; i++) {
    cumulative += buckets[i].probability;
    if (!foundLow && buckets[i].probability > 0 && cumulative > (1 - nominal) / 2 + 1e-12) { low = i; foundLow = true; }
    if (buckets[i].probability > 0 && cumulative >= (1 + nominal) / 2 - 1e-12) { high = i; break; }
  }
  return { lower: buckets[low].lower, upper: buckets[high].upper, probability: buckets.slice(low, high + 1).reduce((s, b) => s + b.probability, 0) };
}

export function summarize(buckets: Bucket[]): ForecastSummary {
  if (!buckets.length) throw new Error("No valid buckets");
  const modalBucket = buckets.reduce((best, b) => b.probability > best.probability ? b : best);
  return { modalBucket, central80: centralInterval(buckets, .8) };
}

export function thresholdProbability(buckets: Bucket[], operator: Operator, threshold: number): ThresholdResult {
  if (!Number.isFinite(threshold) || !buckets.some(b => b.lower === threshold || b.upper === threshold)) throw new Error("Threshold must be an offered bucket boundary");
  return { operator, threshold, probability: buckets.filter(b => operator === "above" ? b.lower >= threshold : b.upper <= threshold).reduce((s, b) => s + b.probability, 0), caveat: BOUNDARY_CAVEAT };
}

export function brier(buckets: Bucket[], winner: number): number {
  if (!buckets.some(b => b.optionId === winner)) throw new Error("Winner not in original bins");
  return buckets.reduce((s, b) => s + (b.probability - (b.optionId === winner ? 1 : 0)) ** 2, 0);
}

export function selectLeadSnapshot(snapshots: Forecast[], targetMs: number, leadSeconds: number, maxAgeSeconds: number): Forecast | null {
  const cutoff = targetMs - leadSeconds * 1000;
  return snapshots.filter(s => s.source === "live" && Date.parse(s.capturedAt) <= cutoff && Date.parse(s.capturedAt) >= cutoff - maxAgeSeconds * 1000 && Date.parse(s.capturedAt) < targetMs).sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt))[0] ?? null;
}
