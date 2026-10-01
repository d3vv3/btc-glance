import { describe, expect, it } from "vitest";
import { centralInterval, convertQuotes, summarize } from "../src/lib/forecast";
import { bracketDirection, compactPriceRange, dailySlots, distributionRanges, horizonTargets, marketOutlook, millisatsToSats, modalMidpoint, pricePosition, projectionModel, quoteMetrics } from "../src/lib/projection";
import type { ForecastResult, TimelineResult } from "../src/lib/types";
import { market, now, quote } from "./fixtures";

const buckets = convertQuotes(quote(), 3).buckets;
function target(i: number, overrides: Partial<ForecastResult> = {}): ForecastResult {
  const targetAt = new Date(now + (i + 1) * 3600000).toISOString();
  return { market: { ...market, topicId: i + 1, targetAt }, status: "ready", diagnostics: [], freshUntil: new Date(now + 300000).toISOString(), forecast: { snapshotId: i + 1, topicId: i + 1, targetAt, capturedAt: new Date(now).toISOString(), source: "live", buckets, summary: summarize(buckets), transformationVersion: "quote-share-v1", originalYesSum: 100, normalizationFactor: 1, normalized: false, interpretation: "quote-share-not-calibrated", caveat: "" }, ...overrides };
}
const data = (targets: ForecastResult[]): TimelineResult => ({ cadence: "hourly", asOf: new Date(now).toISOString(), collectedAt: new Date(now).toISOString(), source: "live", targets });
describe("whole-bin projection", () => {
  it.each([.5, .8, .9])("advances exact lower CDF ties but includes upper ties for central %s", nominal => {
    const tail = (1 - nominal) / 2;
    for (const perturbation of [0, -1e-14, 1e-14]) {
      const bins = buckets.map((b, i) => ({ ...b, probability: [tail + perturbation, nominal, tail - perturbation][i] }));
      const interval = centralInterval(bins, nominal);
      expect(interval).toEqual({ lower: 1000, upper: 2000, probability: nominal });
      expect(distributionRanges(bins)!.bands.find(b => b.nominal === nominal)).toEqual({ nominal, ...interval });
      expect(distributionRanges(bins)!.bands[1]).toEqual({ nominal: .8, ...summarize(bins).central80 });
    }
  });
  it("maps decimal and very narrow nonzero supports across the full pixel extent without row overlap", () => {
    for (const [lower, upper] of [[.1, .4], [1, 1 + 1e-10]]) {
      expect(pricePosition(lower, lower, upper, 28, 270)).toBe(270);
      expect(pricePosition(upper, lower, upper, 28, 270)).toBe(28);
      const boundaries = Array.from({ length: 1001 }, (_, i) => lower + (upper - lower) * i / 1000);
      const heights = boundaries.slice(1).map((at, i) => pricePosition(boundaries[i], lower, upper, 28, 270) - pricePosition(at, lower, upper, 28, 270));
      expect(heights.every(h => h > 0 && h < 1)).toBe(true);
      expect(heights.reduce((sum, h) => sum + h, 0)).toBeCloseTo(242);
    }
  });
  it.each([3, 7, 14] as const)("keeps all %s UTC dates including missing first, middle and last markets", horizon => {
    const r = target(0);
    const targetAt = new Date(now + 2 * 86400000).toISOString();
    const timeline: TimelineResult = { ...data([{ ...r, market: { ...r.market!, cadence: "daily", targetAt }, forecast: { ...r.forecast!, targetAt } }]), cadence: "daily" };
    const model = projectionModel(horizonTargets(timeline, now + 12 * 3600000, horizon), now, false, "range");
    const slots = dailySlots(model.columns, now + 12 * 3600000, horizon);
    expect(slots.map(s => s.date)).toEqual(Array.from({ length: horizon }, (_, i) => new Date(now + (i + 1) * 86400000).toISOString().slice(0, 10)));
    expect(slots[0].column).toBeNull(); expect(slots.at(-1)!.column).toBeNull();
    expect(slots[1].column?.targetAt).toBe(targetAt);
    expect(model.segments).toEqual([[0]]);
    expect(dailySlots([], now, horizon).every(s => s.column === null)).toBe(true);
  });
  it("uses a discrete median and conservative whole-bin coverage, never interpolated prices", () => {
    const ranges = distributionRanges(buckets)!;
    expect(ranges.median.label).toBe("1000-2000");
    expect(ranges.midpoint).toBe(1500);
    expect(ranges.bands.map(b => [b.nominal, b.lower, b.upper, b.probability])).toEqual([[.5, 1000, 2000, .6], [.8, 0, 3000, 1], [.9, 0, 3000, 1]]);
    const exact = buckets.map((b, i) => ({ ...b, probability: [.5, 0, .5][i] }));
    expect(distributionRanges(exact)!.median).toBe(exact[0]);
    for (const probability of [NaN, Infinity, -.1, 1.1]) expect(distributionRanges([{ ...buckets[0], probability }])).toBeNull();
    expect(distributionRanges(buckets.map(b => ({ ...b, probability: .1 })))).toBeNull();
  });
  it("supports independent unequal bins in Range without heatmap interpolation", () => {
    const second = target(1);
    const bins = buckets.map((b, i) => ({ ...b, lower: [0, 1000, 2500][i], upper: [1000, 2500, 3000][i] }));
    second.forecast = { ...second.forecast!, buckets: bins, summary: summarize(bins) };
    expect(projectionModel(data([target(0), second]), now, false, "range").columns[1].ranges?.median.upper).toBe(2500);
    expect(projectionModel(data([target(0), second]), now, false, "heatmap").columns[1].available).toBe(false);
  });
  it("keeps 3/7/14 day horizons and unavailable calendar slots without fabricating markets", () => {
    const daily = Array.from({ length: 14 }, (_, i) => {
      const r = target(i); const targetAt = new Date(now + (i + 1) * 86400000).toISOString();
      return { ...r, market: { ...r.market!, cadence: "daily" as const, targetAt }, forecast: { ...r.forecast!, targetAt } };
    });
    const timeline = { ...data(daily), cadence: "daily" as const };
    for (const horizon of [3, 7, 14] as const) expect(horizonTargets(timeline, now, horizon).targets).toHaveLength(horizon);
    timeline.targets = daily.filter((_, i) => i !== 1);
    timeline.targets[2] = { ...timeline.targets[2], status: "stale" };
    const model = projectionModel(timeline, now, false, "range");
    const slots = dailySlots(model.columns, now, 14);
    expect(slots).toHaveLength(14); expect(slots[1].column).toBeNull();
    expect(slots[3].column?.available).toBe(false);
    expect(model.segments.slice(0, 3)).toEqual([[0], [1], [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]]);
  });
  it("converts source millisats into sats, not dollar price units", () => {
    expect(millisatsToSats(1234567)).toBe(1234.567);
    expect(millisatsToSats(0)).toBe(0);
    for (const value of [null, undefined, NaN, Infinity, -1]) expect(millisatsToSats(value)).toBeNull();
    const result = target(0); result.market!.volume24hMillisats = 99999;
    expect(quoteMetrics(result).volume24hMillisats).toBeNull();
    result.provenance = { snapshotId: 1, capturedAt: new Date(now).toISOString(), raw: { volume_24h_millisats: 1234567, total_volume_millisats: -1, liquidity_locked_millisats: 12000 } };
    expect(quoteMetrics(result)).toEqual({ volume24hMillisats: 1234567, totalVolumeMillisats: null, liquidityMillisats: 12000 });
  });
  it("conserves decimal-bin mass despite rounded display geometry", () => {
    const decimal = target(0);
    const bins = [.1, .2, .3].map((lower, i) => ({ ...buckets[i], lower, upper: [.2, .3, .4][i] }));
    decimal.forecast = { ...decimal.forecast!, buckets: bins, summary: summarize(bins) };
    const model = projectionModel(data([decimal]), now);
    expect(model.columns[0].available).toBe(true);
    expect(model.columns[0].masses).toEqual(bins.map(b => b.probability));
    expect(Math.abs(model.columns[0].masses.reduce((a, b) => a + b, 0) - 1)).toBeLessThan(1e-9);
  });
  it("conserves grouped decimal bins on shifted supports", () => {
    const targets = [target(0), target(1)];
    targets.forEach((result, offset) => {
      const bins = Array.from({ length: 100 }, (_, i) => ({ ...buckets[0], optionId: i + 1, lower: (i + offset + 1) / 10, upper: (i + offset + 2) / 10, probability: .01 }));
      result.forecast = { ...result.forecast!, buckets: bins, summary: summarize(bins) };
    });
    const model = projectionModel(data(targets), now);
    for (const column of model.columns) {
      expect(column.available).toBe(true);
      expect(Math.abs(column.masses.reduce((a, b) => a + b, 0) + column.omittedMass! - 1)).toBeLessThan(1e-9);
    }
  });
  it("uses the original modal bracket and midpoint, conserving each target's mass", () => {
    const model = projectionModel(data([target(0), target(1)]), now);
    expect(model.columns[0].result.forecast?.summary.modalBucket.label).toBe("1000-2000");
    expect(model.columns[0].midpoint).toBe(1500); expect(modalMidpoint({ ...buckets[0], lower: 1000, upper: 3000 })).toBe(2000);
    for (const column of model.columns) expect(column.masses.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(model.segments).toEqual([[0, 1]]);
  });
  it("does not bridge stale, invalid, expired, cached, or absent targets", () => {
    expect(projectionModel(data([target(0), target(1, { status: "stale" }), target(2), target(4)]), now).segments).toEqual([[0], [2], [3]]);
    for (const status of ["invalid", "expired", "unavailable"] as const) expect(projectionModel(data([target(0), target(1, { status })]), now).columns[1].available).toBe(false);
    expect(projectionModel(data([target(0), target(1)]), now, true).segments).toEqual([]);
    expect(projectionModel(data([target(0)]), now + 300001).segments).toEqual([]);
    expect(projectionModel(data([target(0)]), now + 3600000).segments).toEqual([]);
    expect(projectionModel(data([target(0)]), null).segments).toEqual([]);
  });
  it("rejects unequal widths and nonaligned boundaries without splitting probability mass", () => {
    const second = target(1); second.forecast = { ...second.forecast!, buckets: buckets.map((b, i) => ({ ...b, lower: b.lower + (i === 1 ? 100 : 0) })) };
    const model = projectionModel(data([target(0), second]), now);
    expect(model.columns[1].reason).toBe("Invalid distribution"); expect(model.columns[1].masses.every(p => p === 0)).toBe(true);
  });
  it("aggregates whole adjacent bins into at most 40 readable rows and retains original tie semantics", () => {
    const wide = target(0); const many = Array.from({ length: 100 }, (_, i) => ({ ...buckets[0], optionId: i + 1, label: `${i * 1000}-${(i + 1) * 1000}`, lower: i * 1000, upper: (i + 1) * 1000, probability: .01, quoteShare: .01 }));
    wide.forecast = { ...wide.forecast!, buckets: many, summary: summarize(many) };
    const model = projectionModel(data([wide]), now);
    expect(model.rows.length).toBeLessThanOrEqual(40); expect(model.columns[0].masses.reduce((a, b) => a + b, 0) + model.columns[0].omittedMass!).toBeCloseTo(1);
    expect(model.rows.every(row => pricePosition(row.lower, model.lower, model.upper, 28, 270) - pricePosition(row.upper, model.lower, model.upper, 28, 270) >= 6)).toBe(true);
    expect(model.columns[0].midpoint).toBe(500); expect(wide.forecast.summary.modalBucket.label).toBe("0-1000");
  });
});

describe("market outlook and focused heatmap", () => {
  const narrow = (lower: number, upper = lower + 200) => distributionRanges([{ ...buckets[0], lower, upper, probability: 1 }])!;
  it("classifies original median brackets, with windy width precedence and a neutral reference", () => {
    const reference = narrow(84000);
    expect(marketOutlook(reference, reference, true)).toBe("steady");
    expect(marketOutlook(narrow(84200), reference)).toBe("sunny");
    expect(marketOutlook(narrow(83800), reference)).toBe("rainy");
    expect(marketOutlook(narrow(80000), reference)).toBe("snowy");
    expect(marketOutlook(narrow(84100), reference)).toBe("steady");
    expect(marketOutlook(narrow(90000, 100000), reference)).toBe("windy");
    expect(marketOutlook(narrow(70000, 80000), reference)).toBe("windy");
    expect(marketOutlook(narrow(70000, 80000), reference, true)).toBe("steady");
    expect(marketOutlook(null, reference)).toBe("unavailable");
    expect(marketOutlook(reference, null)).toBe("unavailable");
    expect(marketOutlook(narrow(92000, 100000), reference)).toBe("windy");
    expect(marketOutlook(narrow(96000, 104000), reference)).toBe("windy");
    expect(marketOutlook(narrow(96900, 97100), narrow(99900, 100100))).toBe("snowy");
    expect(marketOutlook(narrow(97000, 97200), narrow(99900, 100100))).toBe("rainy");
    expect(marketOutlook({ ...reference, midpoint: NaN }, reference)).toBe("unavailable");
    expect(marketOutlook(reference, { ...reference, midpoint: Infinity })).toBe("unavailable");
    expect(marketOutlook(narrow(81200, 81400), narrow(84000, 84200))).toBe("snowy");
    expect(bracketDirection({ lower: 83900, upper: 84100 }, reference.median)).toBe("neutral");
    expect(compactPriceRange({ lower: 84200, upper: 84400 })).toBe("$84.2k-$84.4k");
    expect(distributionRanges([{ ...buckets[0], lower: -200, upper: -100, probability: 1 }])).toBeNull();
  });
  it("focuses on whole-bin central90 union plus two bins and accounts for exact excluded shares", () => {
    const targets = [target(0), target(1)];
    targets.forEach((result, j) => {
      const bins = Array.from({ length: 100 }, (_, i) => ({ ...buckets[0], lower: 25000 + i * 1000, upper: 26000 + i * 1000, probability: i === 59 + j ? .92 : i === 0 || i === 99 ? .04 : 0 }));
      result.forecast = { ...result.forecast!, buckets: bins, summary: summarize(bins) };
    });
    const model = projectionModel(data(targets), now);
    expect([model.lower, model.upper]).toEqual([82000, 88000]);
    expect(model.rows).toHaveLength(6);
    for (const column of model.columns) {
      expect(column.masses.reduce((a, b) => a + b, 0)).toBeCloseTo(.92);
      expect(column.omittedMass).toBeCloseTo(.08);
      expect(column.masses.filter(m => m > 0)).toEqual([.92]);
    }
    const range = projectionModel(data(targets), now, false, "range");
    expect([range.lower, range.upper]).toEqual([84000, 86000]);
    expect(range.columns.every(c => c.omittedMass === null)).toBe(true);
    const invalid = target(2); invalid.forecast!.buckets = [{ ...buckets[0], probability: -1 }];
    expect(projectionModel(data([invalid]), now).reference).toBeNull();
    expect(projectionModel(data([invalid]), now).columns[0].omittedMass).toBeNull();
  });
  it("clamps context to original support and never fabricates rows beyond it", () => {
    const result = target(0);
    const bins = buckets.map((b, i) => ({ ...b, probability: i === 0 ? 1 : 0 }));
    result.forecast = { ...result.forecast!, buckets: bins, summary: summarize(bins) };
    const model = projectionModel(data([result]), now);
    expect(model.lower).toBe(0); expect(model.upper).toBe(3000);
    expect(model.columns[0].omittedMass).toBe(0);
    expect(model.rows.every(row => bins.some(b => b.lower === row.lower) && bins.some(b => b.upper === row.upper))).toBe(true);
  });
  it("selects the earliest valid reference after stale gaps without connecting them", () => {
    const model = projectionModel(data([target(3), target(0, { status: "stale" }), target(1)]), now);
    expect(model.reference?.targetAt).toBe(target(1).market!.targetAt);
    expect(model.columns.map(c => c.outlook)).toEqual(["unavailable", "steady", "windy"]);
    expect(model.segments).toEqual([[1], [2]]);
  });
});
