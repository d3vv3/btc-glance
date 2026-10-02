import type { Bucket, ForecastResult, PriceObservation, TimelineResult, TimelineTarget } from "./types";
import { centralInterval } from "./forecast";

export interface CentralBand { nominal: number; lower: number; upper: number; probability: number }
export interface DistributionRanges { median: Bucket; midpoint: number; bands: CentralBand[] }
export interface ProjectionColumn { result: TimelineTarget; kind: "past" | "future"; observed: number | null; targetAt: string; topicId: number; available: boolean; reason: string; midpoint: number | null; ranges: DistributionRanges | null; masses: number[]; heatmapAvailable: boolean; omittedMass: number | null; outlook: MarketOutlook; direction: ProjectionDirection; sentiment: SentimentResult }
export interface ProjectionModel { rows: { lower: number; upper: number }[]; columns: ProjectionColumn[]; segments: number[][]; bandSegments: number[][]; lower: number; upper: number; reference: { targetAt: string; ranges: DistributionRanges } | null; focus: { topicId: number; targetAt: string; central90: CentralBand; fallback: boolean } | null; peakMass: number; unequalFinalRow: boolean }

export const OUTLOOK_WIDE_RANGE_RATIO = .08;
export const OUTLOOK_STRONG_DROP_RATIO = .03;
export const PROJECTION_COLORS = { higher: "#6cdb9a", lower: "#f47e87", neutral: "#ffbc48", unavailable: "#8c9599" };
export type MarketOutlook = "sunny" | "rainy" | "snowy" | "windy" | "steady" | "unavailable";
export const OUTLOOK_LABELS: Record<MarketOutlook, string> = { sunny: "Rising", rainy: "Falling", snowy: "Falling", windy: "Wide range", steady: "Steady", unavailable: "No comparison" };
export const PROJECTION_DIRECTION_EPSILON = 1e-8;
export type ProjectionDirection = "higher" | "lower" | "neutral" | "unavailable";
export const DIRECTION_LABELS: Record<ProjectionDirection, string> = { higher: "Rising", lower: "Falling", neutral: "Steady", unavailable: "No comparison" };
export interface SentimentReference { value: number; time: string }
export interface SentimentResult { label: "Bullish" | "Bearish" | "Mixed" | null; up: number | null; down: number | null; undecided: number | null; reference: SentimentReference | null }
export const SENTIMENT_EPSILON = 1e-9;
const unavailableSentiment = (): SentimentResult => ({ label: null, up: null, down: null, undecided: null, reference: null });

export function distributionSentiment(buckets: Bucket[], reference: SentimentReference | null): SentimentResult {
  if (!reference || !Number.isFinite(reference.value) || reference.value <= 0 || !Number.isFinite(Date.parse(reference.time)) || !distributionRanges(buckets)) return unavailableSentiment();
  const total = buckets.reduce((sum, b) => sum + b.probability, 0);
  let up = 0, down = 0, undecided = 0;
  // Touching or containing the reference is undecided: never split a source bin.
  for (const b of buckets) {
    const weight = b.probability / total;
    if (b.lower > reference.value) up += weight;
    else if (b.upper < reference.value) down += weight;
    else undecided += weight;
  }
  return { label: up + SENTIMENT_EPSILON >= .6 ? "Bullish" : down + SENTIMENT_EPSILON >= .6 ? "Bearish" : "Mixed", up, down, undecided, reference };
}

function completedObservation(r: TimelineTarget, data: TimelineResult, now: number | null): PriceObservation | null {
  const o = r.observed;
  if (r.kind !== "past" || !o || now === null || !Number.isFinite(now) || o.source !== "Kraken" || o.pair !== "XBTUSD" || o.cadence !== data.cadence || o.interval !== (data.cadence === "daily" ? 1440 : 60) || !Number.isFinite(o.value) || o.value <= 0) return null;
  const start = Date.parse(o.candleStart), end = Date.parse(o.candleEnd), fetched = Date.parse(o.fetchedAt), target = Date.parse(r.targetAt ?? r.market?.targetAt ?? ""), cutoff = Math.min(now, Date.parse(data.asOf));
  const duration = o.interval * 60000;
  return [start, end, fetched, target, cutoff].every(Number.isFinite) && end === target && end - start === duration && start % duration === 0 && end <= fetched && fetched <= cutoff ? o : null;
}

export function sentimentReference(data: TimelineResult, now: number | null): SentimentReference | null {
  const latest = data.targets.map(r => completedObservation(r, data, now)).filter((o): o is PriceObservation => o !== null).sort((a, b) => Date.parse(b.candleEnd) - Date.parse(a.candleEnd))[0];
  return latest ? { value: latest.value, time: latest.candleEnd } : null;
}

export function sentimentOutlook(sentiment: SentimentResult, ranges: DistributionRanges | null): MarketOutlook {
  if (!sentiment.label || !ranges) return "unavailable";
  const interval = ranges.bands.find(b => b.nominal === .8);
  if (interval && (interval.upper - interval.lower) / ranges.midpoint >= OUTLOOK_WIDE_RANGE_RATIO) return "windy";
  return sentiment.label === "Bullish" ? "sunny" : sentiment.label === "Bearish" ? "rainy" : "steady";
}
export function midpointDirection(current: number | null, previous: number | null): ProjectionDirection {
  if (current === null || previous === null || !Number.isFinite(current) || !Number.isFinite(previous)) return "unavailable";
  const delta = current - previous;
  return delta > PROJECTION_DIRECTION_EPSILON ? "higher" : delta < -PROJECTION_DIRECTION_EPSILON ? "lower" : "neutral";
}
export function guideMidpoint(column: ProjectionColumn, mode: "range" | "heatmap"): number | null {
  if (column.kind === "past") return column.observed;
  return column.available ? mode === "range" ? column.ranges?.midpoint ?? null : column.midpoint : null;
}
export function bracketDirection(bracket: { lower: number; upper: number }, reference: { lower: number; upper: number }): "higher" | "lower" | "neutral" {
  return bracket.lower >= reference.upper ? "higher" : bracket.upper <= reference.lower ? "lower" : "neutral";
}
export function marketOutlook(ranges: DistributionRanges | null, reference: DistributionRanges | null, current = ranges?.midpoint ?? null, previous = reference?.midpoint ?? null): MarketOutlook {
  if (!ranges || !reference || !Number.isFinite(ranges.midpoint) || ranges.midpoint <= 0 || !Number.isFinite(reference.midpoint) || reference.midpoint <= 0 || [ranges.median, reference.median].some(b => !Number.isFinite(b.lower) || !Number.isFinite(b.upper) || b.lower < 0 || b.upper <= b.lower)) return "unavailable";
  const direction = midpointDirection(current, previous);
  if (direction === "unavailable" || current! <= 0 || previous! <= 0) return "unavailable";
  const interval = ranges.bands.find(b => b.nominal === .8);
  if (!interval || !Number.isFinite(interval.lower) || !Number.isFinite(interval.upper) || interval.lower < 0 || interval.upper <= interval.lower) return "unavailable";
  if ((interval.upper - interval.lower) / ranges.midpoint >= OUTLOOK_WIDE_RANGE_RATIO) return "windy";
  return direction === "higher" ? "sunny" : direction === "lower" ? (previous! - current!) / previous! >= OUTLOOK_STRONG_DROP_RATIO ? "snowy" : "rainy" : "steady";
}
export function compactPriceRange(bracket: { lower: number; upper: number }): string {
  const format = (value: number) => value >= 1000 ? `$${(value / 1000).toLocaleString("en-US", { maximumFractionDigits: 2 })}k` : `$${value.toLocaleString("en-US", { maximumFractionDigits: 20 })}`;
  return `${format(bracket.lower)}-${format(bracket.upper)}`;
}
export function quoteShareLabel(mass: number): string {
  return mass > 0 && mass < .001 ? "<0.1%" : `${(mass * 100).toFixed(1)}%`;
}
export function heatmapOpacity(mass: number, peakMass: number): number {
  return mass > 0 && peakMass > 0 ? Math.sqrt(Math.min(1, mass / peakMass)) : 0;
}
export function nextHeatmapCell(columns: ProjectionColumn[], rows: ProjectionModel["rows"], cell: { column: number; row: number }, key: string) {
  const horizontal = key === "ArrowLeft" || key === "ArrowRight";
  const step = key === "ArrowLeft" || key === "ArrowDown" ? -1 : 1;
  let { column, row } = cell;
  while (true) {
    if (horizontal) column += step; else row += step;
    if (column < 0 || column >= columns.length || row < 0 || row >= rows.length) return cell;
    if (columns[column].available && columns[column].masses[row] > 0) return { column, row };
    if (horizontal && columns[column].available) {
      const nearest = columns[column].masses.map((mass, i) => ({ mass, i })).filter(b => b.mass > 0).sort((a, b) => Math.abs(a.i - row) - Math.abs(b.i - row))[0];
      if (nearest) return { column, row: nearest.i };
    }
  }
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
   const past = data.targets.filter(r => r.kind === "past");
   if (data.cadence === "hourly") return { ...data, targets: [...past, ...future.filter(r => Date.parse(r.market!.targetAt) <= now + horizon * step)] };
  const start = dailyAnchor(now);
   return { ...data, targets: [...past, ...future.filter(r => Date.parse(r.market!.targetAt) >= start && Date.parse(r.market!.targetAt) < start + horizon * step)] };
}

// Calendar slots are not synthetic markets or forecasts. Missing days have no target ID.
export function dailySlots(columns: ProjectionColumn[], now: number, horizon: Horizon) {
  const first = dailyAnchor(now);
   const pastCount = columns.filter(c => c.kind === "past").length;
   return Array.from({ length: horizon + pastCount }, (_, i) => {
     const date = new Date(first + (i - pastCount) * 86400000).toISOString().slice(0, 10);
    return { date, column: columns.find(c => c.targetAt.slice(0, 10) === date) ?? null };
  });
}

export function hourlySlots(columns: ProjectionColumn[], now: number, horizon: Horizon) {
  const times = columns.map(c => Date.parse(c.targetAt)).filter(at => Number.isFinite(at) && at > now);
  // Follow the actual settlement phase, not an assumed top-of-hour schedule.
  const phase = times.length ? Math.min(...times) % 3600000 : 0;
  const first = Math.floor((now - phase) / 3600000) * 3600000 + phase + 3600000;
   const past = columns.filter(c => c.kind === "past").map(c => Date.parse(c.targetAt));
   const calendar = Array.from({ length: horizon }, (_, i) => first + i * 3600000);
   return [...new Set([...past, ...calendar, ...times])].sort((a, b) => a - b).map(at => ({
    date: new Date(at).toISOString(), column: columns.find(c => Date.parse(c.targetAt) === at) ?? null,
  }));
}

function eligibleArchive(r: TimelineTarget, cadence: TimelineResult["cadence"]): boolean {
  const { archive, forecast, market, provenance } = r;
  if (!archive || !forecast || !market || archive.snapshotId !== forecast.snapshotId) return false;
  const target = Date.parse(market.targetAt), captured = Date.parse(forecast.capturedAt), cutoff = Date.parse(archive.cutoff);
  if (![target, captured, cutoff].every(Number.isFinite) || (r.targetAt !== undefined && Date.parse(r.targetAt) !== target)) return false;
  if (provenance && (provenance.snapshotId !== forecast.snapshotId || Date.parse(provenance.capturedAt) !== captured)) return false;
  if (archive.capturedAt !== undefined && Date.parse(archive.capturedAt) !== captured) return false;
  if (archive.policy === "latest-valid-pre-target") {
    const age = cadence === "hourly" ? 14400 : 172800;
    return !!provenance && Date.parse(archive.capturedAt) === captured && archive.maxSnapshotAgeSeconds === age && cutoff === target - 60000 && captured <= cutoff && captured >= target - age * 1000 && archive.leadSeconds === (target - captured) / 1000;
  }
  return (archive.policy === undefined || archive.policy === "fixed-lead") && archive.leadSeconds === (cadence === "hourly" ? 3600 : 86400) && archive.maxSnapshotAgeSeconds === 300 && cutoff === target - archive.leadSeconds * 1000 && captured <= cutoff && captured >= cutoff - 300000;
}

export function projectionModel(data: TimelineResult, now: number | null, cached = false, mode: "range" | "heatmap" = "heatmap", selectedTopicId: number | null = null): ProjectionModel {
   const observedReference = sentimentReference(data, now);
   const eligible = (r: TimelineTarget) => now !== null && r.status === "ready" && !!r.forecast && !!r.market && (r.kind === "past" ? eligibleArchive(r, data.cadence) && Date.parse(r.market.targetAt) <= Math.min(now, Date.parse(data.asOf)) : !cached && !!r.freshUntil && Date.parse(r.freshUntil) >= now && Date.parse(r.forecast.targetAt) > now) && Date.parse(r.forecast.capturedAt) <= Math.min(now, Date.parse(data.asOf)) && r.market.cadence === data.cadence && r.market.topicId === r.forecast.topicId && r.market.targetAt === r.forecast.targetAt && r.forecast.source === data.source && r.market.source === data.source && !!distributionRanges(r.forecast.buckets);
   const targets = [...data.targets].sort((a, b) => Date.parse(a.targetAt ?? a.market?.targetAt ?? "") - Date.parse(b.targetAt ?? b.market?.targetAt ?? ""));
   const referenceResult = targets.find(r => r.kind !== "past" && eligible(r));
  const reference = referenceResult ? { targetAt: referenceResult.market!.targetAt, ranges: distributionRanges(referenceResult.forecast!.buckets)! } : null;
  const uniform = (r: ForecastResult) => !!r.forecast?.buckets.length && r.forecast.buckets.every(b => Math.abs(b.upper - b.lower - (r.forecast!.buckets[0].upper - r.forecast!.buckets[0].lower)) < 1e-8);
  const selectedResult = targets.find(r => r.market?.topicId === selectedTopicId);
   const focusResult = selectedResult && eligible(selectedResult) && uniform(selectedResult) ? selectedResult : targets.find(r => r.kind !== "past" && eligible(r) && uniform(r));
  const focus = mode === "heatmap" && focusResult ? { topicId: focusResult.market!.topicId, targetAt: focusResult.market!.targetAt, central90: distributionRanges(focusResult.forecast!.buckets)!.bands[2], fallback: selectedTopicId !== null && focusResult !== selectedResult } : null;
  const referenceBins = (mode === "heatmap" ? focusResult : referenceResult)?.forecast?.buckets.slice().sort((a, b) => a.lower - b.lower);
  const width = referenceBins?.[0] ? referenceBins[0].upper - referenceBins[0].lower : 0;
  const anchor = referenceBins?.[0]?.lower ?? 0;
  const aligned = (value: number) => Math.abs((value - anchor) / width - Math.round((value - anchor) / width)) < 1e-8;
  const compatible = (r: ForecastResult) => width > 0 && !!r.forecast?.buckets.length && r.forecast.buckets.every(b => Math.abs(b.upper - b.lower - width) < 1e-8 && aligned(b.lower) && aligned(b.upper));
  const valid = targets.filter(r => eligible(r) && (mode === "range" || compatible(r)));
  const outer = valid.map(r => distributionRanges(r.forecast!.buckets)!.bands[2]);
  const firstBin = focus ? Math.max(0, referenceBins!.findIndex(b => b.lower === focus.central90.lower) - 2) : 0;
  const lastBin = focus ? Math.min(referenceBins!.length - 1, referenceBins!.findIndex(b => b.upper === focus.central90.upper) + 2) : -1;
   const observedValues = targets.flatMap(r => { const o = completedObservation(r, data, now); return o ? [o.value] : []; });
   const extents = [...outer.flatMap(b => [b.lower, b.upper]), ...observedValues];
   const lower = focus ? referenceBins![firstBin].lower : extents.length ? Math.min(...extents) : 0;
   const upper = focus ? referenceBins![lastBin].upper : extents.length ? Math.max(...extents) + (Math.max(...extents) === Math.min(...extents) ? 1 : 0) : 1;
  const count = focus ? lastBin - firstBin + 1 : 0;
  let group = Math.max(1, Math.ceil(count / 40));
  if (count >= 24 && Math.ceil(count / group) < 24) group -= 1;
  const rowCount = count > 0 ? Math.min(40, Math.ceil(count / group)) : 0;
  const rowBoundaries = Array.from({ length: rowCount + 1 }, (_, i) => i === rowCount ? count : i * group);
  const rows = Array.from({ length: rowCount }, (_, i) => ({ lower: referenceBins![firstBin + rowBoundaries[i]].lower, upper: referenceBins![firstBin + rowBoundaries[i + 1] - 1].upper }));
   const columns: ProjectionColumn[] = targets.filter(r => r.market || r.kind === "past").map(result => {
     const targetAt = result.targetAt ?? result.market!.targetAt;
     const kind = result.kind ?? "future";
     const observed = completedObservation(result, data, now)?.value ?? null;
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
     const sentiment = kind === "future" && eligible(result) ? distributionSentiment(result.forecast!.buckets, observedReference) : unavailableSentiment();
     return { result, kind, observed, topicId: result.market?.topicId ?? -Date.parse(targetAt), targetAt, available, reason: kind === "past" ? available ? "Archived" : "No eligible archived forecast" : available ? data.source === "demo" ? "Demo" : "Live" : reason, midpoint: available ? modalMidpoint(result.forecast!.summary.modalBucket) : null, ranges: available ? ranges : null, masses, heatmapAvailable, omittedMass: mode === "heatmap" && heatmapAvailable ? omittedMass : null, outlook: kind === "future" ? sentimentOutlook(sentiment, ranges) : "unavailable", direction: "unavailable", sentiment };
  });
  const segments: number[][] = [];
  const bandSegments: number[][] = [];
  const cadenceMs = data.cadence === "hourly" ? 3600000 : 86400000;
  columns.forEach((c, i) => {
     const previous = columns[i - 1];
     const adjacent = previous && Date.parse(c.targetAt) - Date.parse(previous.targetAt) === cadenceMs;
     if (adjacent) {
       c.direction = midpointDirection(guideMidpoint(c, mode), guideMidpoint(previous, mode));
       if (c.kind === "past") c.outlook = c.direction === "higher" ? "sunny" : c.direction === "lower" ? "rainy" : c.direction === "neutral" ? "steady" : "unavailable";
     }
      if (!c.available) return;
      // Band guides join eligible independent distributions, regardless of capture time or phase.
      if (previous?.available && adjacent) bandSegments[bandSegments.length - 1].push(i);
      else bandSegments.push([i]);
     if (previous?.available && adjacent && c.kind === previous.kind) {
       segments[segments.length - 1].push(i);
    }
    else segments.push([i]);
  });
  const peakMass = columns.reduce((peak, c) => Math.max(peak, ...c.masses), 0);
  return { rows, columns, segments, bandSegments, lower, upper, reference, focus, peakMass, unequalFinalRow: rowCount > 1 && count !== rowCount * group };
}
