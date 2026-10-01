import type { Bucket, ForecastResult, TimelineResult } from "./types";
import { centralInterval } from "./forecast";

export interface CentralBand { nominal: number; lower: number; upper: number; probability: number }
export interface DistributionRanges { median: Bucket; midpoint: number; bands: CentralBand[] }
export interface ProjectionColumn { result: ForecastResult; targetAt: string; topicId: number; available: boolean; reason: string; midpoint: number | null; ranges: DistributionRanges | null; masses: number[]; heatmapAvailable: boolean; omittedMass: number | null; outlook: MarketOutlook }
export interface ProjectionModel { rows: { lower: number; upper: number }[]; columns: ProjectionColumn[]; segments: number[][]; lower: number; upper: number; reference: { targetAt: string; ranges: DistributionRanges } | null }

export const OUTLOOK_WIDE_RANGE_RATIO = .08;
export const OUTLOOK_STRONG_DROP_RATIO = .03;
export const PROJECTION_COLORS = { higher: "#6cdb9a", lower: "#f47e87", neutral: "#ffbc48", unavailable: "#8c9599" };
export type MarketOutlook = "sunny" | "rainy" | "snowy" | "windy" | "steady" | "unavailable";
export const OUTLOOK_LABELS: Record<MarketOutlook, string> = { sunny: "Higher", rainy: "Lower", snowy: "Lower", windy: "Wide range", steady: "Steady", unavailable: "No outlook" };
export function bracketDirection(bracket: { lower: number; upper: number }, reference: { lower: number; upper: number }): "higher" | "lower" | "neutral" {
  return bracket.lower >= reference.upper ? "higher" : bracket.upper <= reference.lower ? "lower" : "neutral";
}
export function marketOutlook(ranges: DistributionRanges | null, reference: DistributionRanges | null, isReference = false): MarketOutlook {
  if (!ranges || !reference || !Number.isFinite(ranges.midpoint) || ranges.midpoint <= 0 || !Number.isFinite(reference.midpoint) || reference.midpoint <= 0 || [ranges.median, reference.median].some(b => !Number.isFinite(b.lower) || !Number.isFinite(b.upper) || b.lower < 0 || b.upper <= b.lower)) return "unavailable";
  if (isReference) return "steady";
  const interval = ranges.bands.find(b => b.nominal === .8);
  if (!interval || !Number.isFinite(interval.lower) || !Number.isFinite(interval.upper) || interval.lower < 0 || interval.upper <= interval.lower) return "unavailable";
  if ((interval.upper - interval.lower) / ranges.midpoint >= OUTLOOK_WIDE_RANGE_RATIO) return "windy";
  const direction = bracketDirection(ranges.median, reference.median);
  return direction === "higher" ? "sunny" : direction === "lower" ? (reference.midpoint - ranges.midpoint) / reference.midpoint >= OUTLOOK_STRONG_DROP_RATIO ? "snowy" : "rainy" : "steady";
}
export function compactPriceRange(bracket: { lower: number; upper: number }): string {
  const format = (value: number) => value >= 1000 ? `$${(value / 1000).toLocaleString("en-US", { maximumFractionDigits: 2 })}k` : `$${value.toLocaleString("en-US", { maximumFractionDigits: 20 })}`;
  return `${format(bracket.lower)}-${format(bracket.upper)}`;
}

export function modalMidpoint(bucket: Bucket): number { return bucket.lower + (bucket.upper - bucket.lower) / 2; }

// Inverse discrete CDF: boundaries stay in the original bins, never interpolated.
export function distributionRanges(buckets: Bucket[]): DistributionRanges | null {
  if (!buckets.length) return null;
  const bins = [...buckets].sort((a, b) => a.lower - b.lower);
  if (bins.some((b, i) => !Number.isFinite(b.lower) || b.lower < 0 || !Number.isFinite(b.upper) || b.upper <= b.lower || !Number.isFinite(b.probability) || b.probability < 0 || b.probability > 1 || (i > 0 && Math.abs(b.lower - bins[i - 1].upper) > 1e-8))) return null;
  if (Math.abs(bins.reduce((sum, b) => sum + b.probability, 0) - 1) > 1e-8) return null;
  const quantile = (q: number) => { let mass = 0; return bins.findIndex(b => { mass += b.probability; return b.probability > 0 && mass + 1e-12 >= q; }); };
  const median = bins[quantile(.5)];
  const bands = [.5, .8, .9].map(nominal => ({ nominal, ...centralInterval(bins, nominal) }));
  return { median, midpoint: modalMidpoint(median), bands };
}

export function millisatsToSats(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value) && value >= 0 ? value / 1000 : null;
}
export function quoteMetrics(result: ForecastResult | null | undefined) {
  const raw = result?.provenance?.raw;
  const quote = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const amount = (key: string) => typeof quote[key] === "number" && Number.isFinite(quote[key]) && quote[key] >= 0 ? quote[key] : null;
  return { volume24hMillisats: amount("volume_24h_millisats"), totalVolumeMillisats: amount("total_volume_millisats"), liquidityMillisats: amount("liquidity_locked_millisats") };
}

export type Horizon = 3 | 7 | 14;
export function dailyAnchor(now: number): number { return Math.floor(now / 86400000) * 86400000 + 86400000; }
export function pricePosition(price: number, lower: number, upper: number, top: number, bottom: number): number {
  const extent = upper - lower;
  return bottom - (price - lower) / (Number.isFinite(extent) && extent > 0 ? extent : Number.EPSILON) * (bottom - top);
}
export function horizonTargets(data: TimelineResult, now: number, horizon: Horizon): TimelineResult {
  const step = data.cadence === "daily" ? 86400000 : 3600000;
  const future = data.targets.filter(r => r.market && Date.parse(r.market.targetAt) > now).sort((a, b) => Date.parse(a.market!.targetAt) - Date.parse(b.market!.targetAt));
  if (data.cadence === "hourly") return { ...data, targets: future.filter(r => Date.parse(r.market!.targetAt) <= now + horizon * step) };
  const start = dailyAnchor(now);
  return { ...data, targets: future.filter(r => Date.parse(r.market!.targetAt) >= start && Date.parse(r.market!.targetAt) < start + horizon * step) };
}

// Calendar slots are not synthetic markets or forecasts. Missing days have no target ID.
export function dailySlots(columns: ProjectionColumn[], now: number, horizon: Horizon) {
  const first = dailyAnchor(now);
  return Array.from({ length: horizon }, (_, i) => {
    const date = new Date(first + i * 86400000).toISOString().slice(0, 10);
    return { date, column: columns.find(c => c.targetAt.slice(0, 10) === date) ?? null };
  });
}

export function projectionModel(data: TimelineResult, now: number | null, cached = false, mode: "range" | "heatmap" = "heatmap"): ProjectionModel {
  const eligible = (r: ForecastResult) => !cached && now !== null && r.status === "ready" && !!r.forecast && !!r.market && !!r.freshUntil && Date.parse(r.freshUntil) >= now && Date.parse(r.forecast.targetAt) > now && Date.parse(r.forecast.capturedAt) <= Math.min(now, Date.parse(data.asOf)) && r.market.cadence === data.cadence && r.market.topicId === r.forecast.topicId && r.market.targetAt === r.forecast.targetAt && r.forecast.source === data.source && !!distributionRanges(r.forecast.buckets);
  const targets = [...data.targets].sort((a, b) => Date.parse(a.market?.targetAt ?? "") - Date.parse(b.market?.targetAt ?? ""));
  const referenceResult = targets.find(eligible);
  const reference = referenceResult ? { targetAt: referenceResult.market!.targetAt, ranges: distributionRanges(referenceResult.forecast!.buckets)! } : null;
  const referenceBins = referenceResult?.forecast?.buckets;
  const width = referenceBins?.[0] ? referenceBins[0].upper - referenceBins[0].lower : 0;
  const anchor = referenceBins?.[0]?.lower ?? 0;
  const aligned = (value: number) => Math.abs((value - anchor) / width - Math.round((value - anchor) / width)) < 1e-8;
  const compatible = (r: ForecastResult) => width > 0 && !!r.forecast?.buckets.length && r.forecast.buckets.every(b => Math.abs(b.upper - b.lower - width) < 1e-8 && aligned(b.lower) && aligned(b.upper));
  const valid = targets.filter(r => eligible(r) && (mode === "range" || compatible(r)));
  const buckets = valid.flatMap(r => r.forecast!.buckets);
  const outer = valid.map(r => distributionRanges(r.forecast!.buckets)!.bands[2]);
  const lower = outer.length ? Math.max(Math.min(...buckets.map(b => b.lower)), Math.min(...outer.map(b => b.lower)) - (mode === "heatmap" ? 2 * width : 0)) : 0;
  const upper = outer.length ? Math.min(Math.max(...buckets.map(b => b.upper)), Math.max(...outer.map(b => b.upper)) + (mode === "heatmap" ? 2 * width : 0)) : 1;
  const count = mode === "heatmap" && width > 0 && buckets.length ? Math.round((upper - lower) / width) : 0;
  const group = Math.max(1, Math.ceil(count / 40));
  const rowCount = count > 0 ? Math.max(1, Math.floor(count / group)) : 0;
  const rowBoundaries = Array.from({ length: rowCount + 1 }, (_, i) => rowCount ? Math.floor(i * count / rowCount) : 0);
  const rows = Array.from({ length: rowCount }, (_, i) => ({ lower: lower + rowBoundaries[i] * width, upper: i === rowCount - 1 ? upper : lower + rowBoundaries[i + 1] * width }));
  const columns: ProjectionColumn[] = targets.filter(r => r.market).map(result => {
    const heatmapAvailable = eligible(result) && compatible(result);
    const available = eligible(result) && (mode === "range" || compatible(result));
    const reason = cached ? "Cached, not live" : result.status === "ready" && result.forecast && !distributionRanges(result.forecast.buckets) ? "Invalid distribution" : !eligible(result) ? result.status === "ready" ? "Stale or expired" : result.status : !compatible(result) ? "Incompatible price bins" : data.source === "demo" ? "Demo" : "Live";
    const masses = rows.map(() => 0);
    let omittedMass = 0;
    // Geometry is only for display; canonical grid indices assign each whole bin once.
    if (mode === "heatmap" && heatmapAvailable) for (const bucket of result.forecast!.buckets) {
      const index = Math.round((bucket.lower - lower) / width);
      if (index < 0 || index >= count) omittedMass += bucket.probability;
      else masses[rowBoundaries.findIndex((boundary, i) => i < rowCount && index >= boundary && index < rowBoundaries[i + 1])] += bucket.probability;
    }
    const ranges = eligible(result) ? distributionRanges(result.forecast!.buckets) : null;
    return { result, topicId: result.market!.topicId, targetAt: result.market!.targetAt, available, reason: available ? data.source === "demo" ? "Demo" : "Live" : reason, midpoint: available ? modalMidpoint(result.forecast!.summary.modalBucket) : null, ranges: available ? ranges : null, masses, heatmapAvailable, omittedMass: mode === "heatmap" && heatmapAvailable ? omittedMass : null, outlook: marketOutlook(ranges, reference?.ranges ?? null, result === referenceResult) };
  });
  const segments: number[][] = [];
  const cadenceMs = data.cadence === "hourly" ? 3600000 : 86400000;
  columns.forEach((c, i) => {
    if (!c.available) return;
    const previous = columns[i - 1];
    if (previous?.available && Math.abs(Date.parse(c.targetAt) - Date.parse(previous.targetAt) - cadenceMs) < 1) segments[segments.length - 1].push(i);
    else segments.push([i]);
  });
  return { rows, columns, segments, lower, upper, reference };
}
