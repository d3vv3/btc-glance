import { describe, expect, it } from "vitest";
import { centralInterval, convertQuotes, summarize } from "../src/lib/forecast";
import { bracketDirection, compactPriceRange, dailySlots, hourlySlots, distributionRanges, distributionSentiment, sentimentReference, heatmapOpacity, horizonTargets, marketOutlook, midpointDirection, millisatsToSats, modalMidpoint, nextHeatmapCell, pricePosition, projectionModel, quoteMetrics, quoteShareLabel } from "../src/lib/projection";
import type { ForecastResult, TimelineResult, TimelineTarget } from "../src/lib/types";
import { market, now, quote } from "./fixtures";

const buckets = convertQuotes(quote(), 3).buckets;
function target(i: number, overrides: Partial<ForecastResult> = {}): ForecastResult {
  const targetAt = new Date(now + (i + 1) * 3600000).toISOString();
  return { market: { ...market, topicId: i + 1, targetAt }, status: "ready", diagnostics: [], freshUntil: new Date(now + 300000).toISOString(), forecast: { snapshotId: i + 1, topicId: i + 1, targetAt, capturedAt: new Date(now).toISOString(), source: "live", buckets, summary: summarize(buckets), transformationVersion: "quote-share-v1", originalYesSum: 100, normalizationFactor: 1, normalized: false, interpretation: "quote-share-not-calibrated", caveat: "" }, ...overrides };
}
const data = (targets: TimelineTarget[]): TimelineResult => ({ cadence: "hourly", asOf: new Date(now).toISOString(), collectedAt: new Date(now).toISOString(), source: "live", targets });
describe("whole-bin projection", () => {
  it.each(["range", "heatmap"] as const)("retains cached and stale %s evidence until settlement without changing captures or shares", mode => {
    const timeline = data([target(0), target(1)]);
    const original = structuredClone(timeline);
    const fresh = projectionModel(timeline, now, false, mode);
    expect(fresh.columns.every(c => c.live)).toBe(true);
    const cached = projectionModel(timeline, now, true, mode, 2);
    expect(cached.columns.every(c => c.available && !c.live && c.reason === "Cached forecast")).toBe(true);
    expect(cached.reference).toEqual(fresh.reference);
    if (mode === "heatmap") expect(cached.focus?.topicId).toBe(2);
    const stale = projectionModel(timeline, now + 300001, false, mode);
    expect(stale.columns.every(c => c.available && !c.live && c.reason === "Stale forecast")).toBe(true);
    expect(stale.columns.map(c => c.masses)).toEqual(fresh.columns.map(c => c.masses));
    expect(projectionModel(data([{ ...target(0), status: "stale" }]), now, false, mode).columns[0]).toMatchObject({ available: true, live: false });
    expect(projectionModel(timeline, now + 3600000, true, mode).columns[0]).toMatchObject({ available: false, live: false });
    expect(horizonTargets(timeline, now + 7200000, 7).targets).toEqual([]);
    expect(timeline).toEqual(original);
  });
  it("retains old captures for a still-future target without an arbitrary age limit", () => {
    const r = target(0), targetAt = new Date(now + 14 * 86400000).toISOString();
    r.market!.targetAt = targetAt; r.forecast!.targetAt = targetAt;
    expect(projectionModel(data([r]), now + 2 * 86400000, true, "range").columns[0]).toMatchObject({ available: true, live: false });
  });
  it.each([
    { capturedAt: new Date(now + 1).toISOString() }, { topicId: 99 }, { source: "demo" },
    { transformationVersion: "unknown" }, { originalYesSum: 0 }, { normalizationFactor: -1 },
    { snapshotId: 0 }, { buckets: buckets.map((b, i) => ({ ...b, probability: i === 0 ? -1 : b.probability })) },
    { buckets: buckets.map((b, i) => ({ ...b, yes: i === 0 ? NaN : b.yes })) },
    { buckets: buckets.map(b => ({ ...b, optionId: 1 })) }, { buckets: null }, { buckets: [null] },
  ])("does not mask newly invalid retained payloads (%j)", override => {
    const valid = target(0);
    expect(projectionModel(data([valid]), now, true).columns[0].available).toBe(true);
    const invalid = { ...valid, forecast: { ...valid.forecast!, ...override } } as ForecastResult;
    expect(projectionModel(data([invalid]), now, true).columns[0]).toMatchObject({ available: false, live: false, ranges: null });
  });
  it.each(["hourly", "daily"] as const)("joins eligible %s archived and future bands without merging line phases or bypassing gaps", cadence => {
    const step = cadence === "daily" ? 86400000 : 3600000;
    const historical = target(0) as TimelineTarget;
    const targetAt = new Date(now).toISOString();
    historical.kind = "past"; historical.targetAt = targetAt;
    historical.market = { ...historical.market!, cadence, targetAt };
    historical.forecast = { ...historical.forecast!, targetAt, capturedAt: new Date(now - step - 1000).toISOString() };
    historical.archive = { snapshotId: historical.forecast.snapshotId, leadSeconds: step / 1000, maxSnapshotAgeSeconds: 300, cutoff: new Date(now - step).toISOString() };
    const future = [1, 2].map(i => {
      const result = target(i);
      const at = new Date(now + i * step).toISOString();
      return { ...result, market: { ...result.market!, cadence, targetAt: at }, forecast: { ...result.forecast!, targetAt: at } };
    });
    const timeline = { ...data([historical, ...future]), cadence };
    const model = projectionModel(timeline, now, false, "range");
    expect(model.bandSegments).toEqual([[0, 1, 2]]);
    expect(model.segments).toEqual([[0], [1, 2]]);
    expect(model.columns[0].observed).toBeNull();
    expect(projectionModel({ ...timeline, targets: [historical, future[1]] }, now, false, "range").bandSegments).toEqual([[0], [1]]);
    expect(projectionModel({ ...timeline, targets: [{ ...historical, forecast: null }, ...future] }, now, false, "range").bandSegments).toEqual([[1, 2]]);
    expect(projectionModel(timeline, now, true, "range").bandSegments).toEqual([[0, 1, 2]]);
    for (const status of ["invalid", "expired", "unavailable"] as const) {
      expect(projectionModel({ ...timeline, targets: [historical, { ...future[0], status }, future[1]] }, now, false, "range").bandSegments).toEqual([[0], [2]]);
    }
    const expired = { ...future[0], freshUntil: new Date(now - 1).toISOString() };
    expect(projectionModel({ ...timeline, targets: [historical, expired, future[1]] }, now, false, "range").bandSegments).toEqual([[0, 1, 2]]);
    const wrongSource = { ...future[0], forecast: { ...future[0].forecast, source: "demo" as const } };
    expect(projectionModel({ ...timeline, targets: [historical, wrongSource, future[1]] }, now, false, "range").bandSegments).toEqual([[0], [2]]);
  });
  it("keeps hourly gaps as calendar slots without manufacturing forecast IDs", () => {
    const model = projectionModel(data([target(0), target(2)]), now, false, "range");
    const slots = hourlySlots(model.columns, now, 3);
    expect(slots.map(s => s.column?.topicId ?? null)).toEqual([1, null, 3]);
    expect(slots.map(s => s.date)).toEqual([1, 2, 3].map(hour => new Date(now + hour * 3600000).toISOString()));
    expect(hourlySlots([], now, 7).every(s => s.column === null)).toBe(true);
  });
  it("preserves actual non-top-of-hour settlements and any irregular target without interpolation", () => {
    const model = projectionModel(data([target(0), target(2)]), now, false, "range");
    const shifted = model.columns.map(c => ({ ...c, targetAt: new Date(Date.parse(c.targetAt) - 1800000).toISOString() }));
    const slots = hourlySlots(shifted, now, 3);
    expect(slots.map(s => s.column?.topicId ?? null)).toEqual([1, null, 3]);
    expect(slots[0].date).toBe(new Date(now + 1800000).toISOString());
    const irregular = { ...shifted[1], topicId: 4, targetAt: new Date(now + 2 * 3600000).toISOString() };
    expect(hourlySlots([...shifted, irregular], now, 3).map(s => s.column?.topicId ?? null)).toEqual([1, null, 4, 3]);
  });
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
    timeline.targets[2] = { ...timeline.targets[2], status: "invalid" };
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
  it("does not bridge invalid, expired, or absent targets", () => {
    expect(projectionModel(data([target(0), target(1, { status: "invalid" }), target(2), target(4)]), now).segments).toEqual([[0], [2], [3]]);
    for (const status of ["invalid", "expired", "unavailable"] as const) expect(projectionModel(data([target(0), target(1, { status })]), now).columns[1].available).toBe(false);
    expect(projectionModel(data([target(0), target(1)]), now, true).segments).toEqual([[0, 1]]);
    expect(projectionModel(data([target(0)]), now + 300001).segments).toEqual([[0]]);
    expect(projectionModel(data([target(0)]), now + 3600000).segments).toEqual([]);
    expect(projectionModel(data([target(0)]), null).segments).toEqual([]);
  });
  it("rejects unequal widths and nonaligned boundaries without splitting probability mass", () => {
    const second = target(1); second.forecast = { ...second.forecast!, buckets: buckets.map((b, i) => ({ ...b, lower: b.lower + (i === 1 ? 100 : 0) })) };
    const model = projectionModel(data([target(0), second]), now);
    expect(model.columns[1].reason).toBe("Invalid or expired forecast"); expect(model.columns[1].masses.every(p => p === 0)).toBe(true);
  });
  it("aggregates whole adjacent bins into at most 40 readable rows and retains original tie semantics", () => {
    const wide = target(0); const many = Array.from({ length: 100 }, (_, i) => ({ ...buckets[0], optionId: i + 1, label: `${i * 1000}-${(i + 1) * 1000}`, lower: i * 1000, upper: (i + 1) * 1000, probability: .01, quoteShare: .01 }));
    wide.forecast = { ...wide.forecast!, buckets: many, summary: summarize(many) };
    const model = projectionModel(data([wide]), now);
    expect(model.rows.length).toBeLessThanOrEqual(40); expect(model.columns[0].masses.reduce((a, b) => a + b, 0) + model.columns[0].omittedMass!).toBeCloseTo(1);
    expect(model.rows).toHaveLength(32);
    expect(model.rows.slice(0, -1).every(row => row.upper - row.lower === 3000)).toBe(true);
    expect(model.rows.at(-1)!.upper - model.rows.at(-1)!.lower).toBe(1000);
    expect(model.unequalFinalRow).toBe(true);
    expect(model.columns[0].midpoint).toBe(500); expect(wide.forecast.summary.modalBucket.label).toBe("0-1000");
  });
});

describe("market outlook and focused heatmap", () => {
  const narrow = (lower: number, upper = lower + 200) => distributionRanges([{ ...buckets[0], lower, upper, probability: 1 }])!;
  it("classifies representative midpoint changes even in overlapping brackets, with windy width precedence", () => {
    const reference = narrow(84000);
    expect(marketOutlook(reference, reference)).toBe("steady");
    expect(marketOutlook(narrow(84200), reference)).toBe("sunny");
    expect(marketOutlook(narrow(83800), reference)).toBe("rainy");
    expect(marketOutlook(narrow(80000), reference)).toBe("snowy");
    expect(marketOutlook(narrow(84100), reference)).toBe("sunny");
    expect(marketOutlook(narrow(90000, 100000), reference)).toBe("windy");
    expect(marketOutlook(narrow(70000, 80000), reference)).toBe("windy");
    expect(marketOutlook(narrow(70000, 80000), null)).toBe("unavailable");
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
  it("focuses on selected whole-bin central90 plus two bins, not the horizon envelope", () => {
    const targets = [target(0), target(1)];
    targets.forEach((result, j) => {
      const bins = Array.from({ length: 100 }, (_, i) => ({ ...buckets[0], optionId: i + 1, lower: 25000 + i * 1000, upper: 26000 + i * 1000, probability: i === 59 + j ? .92 : i === 0 || i === 99 ? .04 : 0 }));
      result.forecast = { ...result.forecast!, buckets: bins, summary: summarize(bins) };
    });
    const model = projectionModel(data(targets), now);
    expect([model.lower, model.upper]).toEqual([82000, 87000]);
    expect(model.rows).toHaveLength(5);
    for (const column of model.columns) {
      expect(column.masses.reduce((a, b) => a + b, 0)).toBeCloseTo(.92);
      expect(column.omittedMass).toBeCloseTo(.08);
      expect(column.masses.filter(m => m > 0)).toEqual([.92]);
    }
    const range = projectionModel(data(targets), now, false, "range");
    expect([range.lower, range.upper]).toEqual([84000, 86000]);
    expect(range.columns.every(c => c.omittedMass === null)).toBe(true);
    const selected = projectionModel(data(targets), now, false, "heatmap", 2);
    expect([selected.lower, selected.upper]).toEqual([83000, 88000]);
    expect(selected.focus?.topicId).toBe(2);
    expect(selected.reference).toEqual(model.reference);
    const invalid = target(2); invalid.forecast!.buckets = [{ ...buckets[0], probability: -1 }];
    expect(projectionModel(data([invalid]), now).reference).toBeNull();
    expect(projectionModel(data([invalid]), now).columns[0].omittedMass).toBeNull();
  });
  it("clips other high-focus targets and accounts for their entire omitted mass without renormalizing", () => {
    const targets = [target(0), target(1)];
    targets.forEach((result, j) => {
      const bins = Array.from({ length: 500 }, (_, i) => ({ ...buckets[0], optionId: i + 1, lower: 25000 + i * 200, upper: 25200 + i * 200, probability: i === (j ? 420 : 297) ? .92 : i === 0 || i === 499 ? .04 : 0 }));
      result.forecast = { ...result.forecast!, buckets: bins, summary: summarize(bins) };
    });
    const model = projectionModel(data(targets), now, false, "heatmap", 1);
    expect([model.lower, model.upper]).toEqual([84000, 85000]);
    expect(model.columns[0].masses.reduce((a, b) => a + b, 0)).toBeCloseTo(.92);
    expect(model.columns[1].masses.every(m => m === 0)).toBe(true);
    expect(model.columns[1].omittedMass).toBeCloseTo(1);
    expect(model.peakMass).toBe(.92);
    const high = projectionModel(data(targets), now, false, "heatmap", 2);
    expect([high.lower, high.upper]).toEqual([108600, 109600]);
    expect(high.columns[0].omittedMass).toBeCloseTo(1);
    expect(high.reference).toEqual(model.reference);
    targets[1].status = "invalid";
    const fallback = projectionModel(data(targets), now, false, "heatmap", 2);
    expect(fallback.focus).toMatchObject({ topicId: 1, fallback: true });
    expect(fallback.columns[1].omittedMass).toBeNull();
    expect(projectionModel(data(targets), now, true, "heatmap", 2).focus).toMatchObject({ topicId: 1, fallback: true });
    expect(projectionModel(data(targets), now, false, "heatmap", 999).focus).toMatchObject({ topicId: 1, fallback: true });
  });
  it("keeps 24-40 whole-bin rows when support allows and uniform groups except the disclosed final row", () => {
    for (const count of [24, 41, 47, 81, 100, 500]) {
      const result = target(0);
      const bins = Array.from({ length: count }, (_, i) => ({ ...buckets[0], optionId: i + 1, lower: i / 10, upper: (i + 1) / 10, probability: 1 / count }));
      result.forecast = { ...result.forecast!, buckets: bins, summary: summarize(bins) };
      const model = projectionModel(data([result]), now);
      expect(model.rows.length).toBeGreaterThanOrEqual(24);
      expect(model.rows.length).toBeLessThanOrEqual(40);
      for (const row of model.rows.slice(0, -1)) expect(row.upper - row.lower).toBeCloseTo(model.rows[0].upper - model.rows[0].lower);
      expect(model.columns[0].masses.reduce((a, b) => a + b, 0) + model.columns[0].omittedMass!).toBeCloseTo(1);
    }
  });
  it("uses one global visible intensity and never rounds nonzero low shares to zero", () => {
    expect(heatmapOpacity(0, .5)).toBe(0);
    expect(heatmapOpacity(.5, .5)).toBe(1);
    expect(heatmapOpacity(.125, .5)).toBe(.5);
    expect(heatmapOpacity(.125, 0)).toBe(0);
    expect(quoteShareLabel(.00001)).toBe("<0.1%");
    expect(quoteShareLabel(.001)).toBe("0.1%");
    expect(quoteShareLabel(0)).toBe("0.0%");
  });
  it("navigates nonzero bands and skips unavailable columns without synthetic tab stops", () => {
    const model = projectionModel(data([target(0), target(1, { status: "invalid" }), target(2)]), now);
    model.columns[0].masses = [.4, 0, .6]; model.columns[2].masses = [0, 1, 0];
    expect(nextHeatmapCell(model.columns, model.rows, { column: 0, row: 0 }, "ArrowUp")).toEqual({ column: 0, row: 2 });
    expect(nextHeatmapCell(model.columns, model.rows, { column: 0, row: 0 }, "ArrowRight")).toEqual({ column: 2, row: 1 });
    expect(nextHeatmapCell(model.columns, model.rows, { column: 2, row: 1 }, "ArrowLeft")).toEqual({ column: 0, row: 0 });
    expect(nextHeatmapCell(model.columns, model.rows, { column: 0, row: 0 }, "ArrowDown")).toEqual({ column: 0, row: 0 });
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
  it("selects the earliest valid reference after invalid gaps without connecting them", () => {
    const model = projectionModel(data([target(3), target(0, { status: "invalid" }), target(1)]), now);
    expect(model.reference?.targetAt).toBe(target(1).market!.targetAt);
    expect(model.columns.map(c => c.outlook)).toEqual(["unavailable", "unavailable", "unavailable"]);
    expect(model.segments).toEqual([[1], [2]]);
  });
  it("compares only consecutive fresh forecasts, independently of the fixed heatmap reference", () => {
    const targets = [target(0), target(1), target(2)];
    targets.forEach((result, i) => {
      const midpoint = [86000, 85500, 86100][i];
      const bins = [{ ...buckets[0], lower: midpoint - 50, upper: midpoint + 50, probability: 1 }];
      result.forecast = { ...result.forecast!, buckets: bins, summary: summarize(bins) };
    });
    for (const mode of ["range", "heatmap"] as const) {
      const model = projectionModel(data(targets), now, false, mode);
      expect(model.columns.map(c => c.direction)).toEqual(["unavailable", "lower", "higher"]);
      expect(model.columns.map(c => c.outlook)).toEqual(["unavailable", "unavailable", "unavailable"]);
      expect(model.reference?.ranges.midpoint).toBe(86000);
      for (const status of ["invalid", "expired", "unavailable"] as const) {
        expect(projectionModel(data([targets[0], { ...targets[1], status }, targets[2]]), now, false, mode).columns[2].direction).toBe("unavailable");
      }
      expect(projectionModel(data([targets[0], targets[2]]), now, false, mode).columns[1].direction).toBe("unavailable");
    }
  });
  it("shares absolute epsilon ties and keeps windy direction independent", () => {
    expect(midpointDirection(100 + 5e-9, 100)).toBe("neutral");
    expect(midpointDirection(100 - 5e-9, 100)).toBe("neutral");
    expect(midpointDirection(100 + 2e-8, 100)).toBe("higher");
    expect(midpointDirection(100 - 2e-8, 100)).toBe("lower");
    expect(midpointDirection(null, 100)).toBe("unavailable");
    const wide = narrow(90000, 100000);
    expect(marketOutlook(wide, narrow(84000))).toBe("windy");
    expect(midpointDirection(wide.midpoint, narrow(84000).midpoint)).toBe("higher");
  });
  it("uses modal direction in Heatmap and median direction in Range when they diverge", () => {
    const targets = [target(0), target(1)];
    targets.forEach((result, j) => {
      const bins = Array.from({ length: 5 }, (_, i) => ({ ...buckets[0], optionId: i + 1, lower: 84000 + i * 200, upper: 84200 + i * 200, probability: (j ? [.4, 0, 0, .35, .25] : [0, .25, .4, .35, 0])[i] }));
      result.forecast = { ...result.forecast!, buckets: bins, summary: summarize(bins) };
    });
    expect(projectionModel(data(targets), now, false, "range").columns[1]).toMatchObject({ direction: "higher", outlook: "unavailable" });
    expect(projectionModel(data(targets), now, false, "heatmap").columns[1]).toMatchObject({ direction: "lower", outlook: "unavailable" });
  });
});

describe("observed-reference whole-bin sentiment", () => {
  const reference = { value: 1500, time: new Date(now).toISOString() };
  const bins = (weights: number[]) => buckets.map((b, i) => ({ ...b, probability: weights[i] }));
  const past = (at = now, value = 1500): TimelineTarget => ({ kind: "past", targetAt: new Date(at).toISOString(), market: null, forecast: null, status: "unavailable", diagnostics: [], observed: { source: "Kraken", pair: "XBTUSD", cadence: "hourly", interval: 60, value, candleStart: new Date(at - 3600000).toISOString(), candleEnd: new Date(at).toISOString(), fetchedAt: new Date(now).toISOString() } });
  it("uses the exact 60% threshold and epsilon on both sides", () => {
    expect(distributionSentiment(bins([.2, .2, .6]), reference)).toMatchObject({ label: "Bullish", up: .6, down: .2, undecided: .2, reference });
    expect(distributionSentiment(bins([.6, .2, .2]), reference).label).toBe("Bearish");
    expect(distributionSentiment(bins([.2, .2000000005, .5999999995]), reference).label).toBe("Bullish");
    expect(distributionSentiment(bins([.5999999995, .2000000005, .2]), reference).label).toBe("Bearish");
    expect(distributionSentiment(bins([.2, .200000002, .599999998]), reference).label).toBe("Mixed");
    expect(distributionSentiment(bins([.599999998, .200000002, .2]), reference).label).toBe("Mixed");
    expect(distributionSentiment(bins([0, 1, 0]), reference)).toMatchObject({ label: "Mixed", up: 0, down: 0, undecided: 1 });
    const normalized = distributionSentiment(bins([.2, .2, .600000001]), reference);
    expect(normalized.up! + normalized.down! + normalized.undecided!).toBeCloseTo(1, 14);
  });
  it("keeps both bins touching an exact boundary undecided", () => {
    expect(distributionSentiment(bins([.6, .4, 0]), { ...reference, value: 1000 })).toMatchObject({ label: "Mixed", up: 0, down: 0, undecided: 1 });
    expect(distributionSentiment(bins([0, .4, .6]), { ...reference, value: 2000 })).toMatchObject({ label: "Mixed", up: 0, down: 0, undecided: 1 });
    expect(distributionSentiment(bins([.6, 0, .4]), { ...reference, value: 2000 })).toMatchObject({ label: "Bearish", down: .6, undecided: .4 });
  });
  it("does not call missing/invalid references or invalid/zero distributions Mixed", () => {
    for (const value of [0, -1, NaN, Infinity]) expect(distributionSentiment(buckets, { ...reference, value }).label).toBeNull();
    expect(distributionSentiment(buckets, null).label).toBeNull();
    expect(distributionSentiment(buckets, { ...reference, time: "invalid" }).label).toBeNull();
    for (const weights of [[0, 0, 0], [-.1, .5, .6], [NaN, .4, .6], [.1, .1, .1]]) expect(distributionSentiment(bins(weights), reference).label).toBeNull();
    expect(distributionSentiment([], reference).label).toBeNull();
  });
  it.each(["hourly", "daily"] as const)("selects the latest completed %s observation without requiring an archive", cadence => {
    const duration = cadence === "daily" ? 86400000 : 3600000;
    const observations = [past(now - duration, 1400), past(now, 1500)];
    observations.forEach(r => { r.observed = { ...r.observed!, cadence, interval: cadence === "daily" ? 1440 : 60, candleStart: new Date(Date.parse(r.targetAt!) - duration).toISOString() }; });
    const timeline = { ...data(observations.reverse()), cadence };
    expect(sentimentReference(timeline, now)).toEqual(reference);
    expect(sentimentReference(timeline, null)).toBeNull();
    expect(sentimentReference({ ...timeline, asOf: "invalid" }, now)).toBeNull();
  });
  it("rejects wrong source, pair, cadence, duration, target, invalid prices and future fetch/candle times", () => {
    const valid = past();
    for (const override of [{ source: "Other" }, { pair: "XBTEUR" }, { cadence: "daily" }, { interval: 1440 }, { value: 0 }, { value: -1 }, { value: NaN }, { value: Infinity }, { fetchedAt: new Date(now + 1).toISOString() }, { fetchedAt: new Date(now - 1).toISOString() }, { candleStart: new Date(now - 1).toISOString() }, { candleEnd: new Date(now + 3600000).toISOString() }]) {
      const bad = { ...valid, observed: { ...valid.observed!, ...override } } as TimelineTarget;
      expect(sentimentReference(data([bad]), now)).toBeNull();
    }
    expect(sentimentReference(data([{ ...valid, kind: "future" }]), now)).toBeNull();
    expect(sentimentReference(data([{ ...valid, targetAt: new Date(now - 3600000).toISOString() }]), now)).toBeNull();
    expect(sentimentReference({ ...data([valid]), asOf: new Date(now - 1).toISOString() }, now)).toBeNull();
    expect(sentimentReference(data([past(now + 3600000)]), now)).toBeNull();
  });
  it("keeps full-distribution sentiment across clipped views and unavailable future forecasts", () => {
    const results = [target(0), target(1)];
    results.forEach((r, j) => {
      const bs = Array.from({ length: 100 }, (_, i) => ({ ...buckets[0], optionId: i + 1, lower: i * 100, upper: (i + 1) * 100, probability: i === (j ? 80 : 40) ? .92 : i === 0 || i === 99 ? .04 : 0 }));
      r.forecast = { ...r.forecast!, buckets: bs, summary: summarize(bs) };
    });
    const timeline = data([past(), ...results]);
    const range = projectionModel(timeline, now, false, "range");
    const heatmap = projectionModel(timeline, now, false, "heatmap", 1);
    expect(heatmap.columns[2].omittedMass).toBeCloseTo(1);
    expect(heatmap.columns.map(c => c.sentiment)).toEqual(range.columns.map(c => c.sentiment));
    expect(heatmap.columns[2].sentiment).toMatchObject({ label: "Bullish", down: .04, undecided: 0 });
    expect(heatmap.columns[2].sentiment.up).toBeCloseTo(.96);
    for (const status of ["invalid", "expired", "unavailable"] as const) expect(projectionModel(data([past(), { ...results[0], status }]), now).columns[1].sentiment.label).toBeNull();
    expect(projectionModel(timeline, now, true).columns[1].sentiment).toEqual(range.columns[1].sentiment);
    expect(projectionModel(data([past(), { ...results[0], forecast: { ...results[0].forecast!, capturedAt: new Date(now + 1).toISOString() } }]), now).columns[1].sentiment.label).toBeNull();
    expect(range.columns[0].sentiment.label).toBeNull();
  });
});
