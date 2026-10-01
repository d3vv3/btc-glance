import { describe, expect, it } from "vitest";
import { brier, convertQuotes, selectLeadSnapshot, summarize, thresholdProbability } from "../src/lib/forecast";
import { now, quote } from "./fixtures";
import type { Forecast } from "../src/lib/types";

describe("quote validation and deterministic summaries", () => {
  it("uses direct YES shares and retains the legacy multiplier", () => {
    const exact = convertQuotes(quote()); expect(exact.buckets.map(b => b.probability)).toEqual([0.2, 0.6, 0.2]);
    const tiny = convertQuotes(quote([20, 59, 20])); expect(tiny.originalYesSum).toBe(99); expect(tiny.normalizationFactor).toBeCloseTo(100 / 99); expect(tiny.buckets.reduce((s, b) => s + b.probability, 0)).toBeCloseTo(1);
    expect(convertQuotes(quote([20, 58, 20])).diagnostics).toEqual([]);
  });
  it.each([[20, 58, 20], [20, 63, 20], [101, 199, 200], [1e-300, 2e-300, 1e-300], [1e300, 2e300, 1e300]])("accepts arbitrary finite nonnegative scale %j", (a, b, c) => {
    const raw = quote([a, b, c]);
    const outcomes = raw.outcomes as { yes_price: number; no_price: number }[];
    outcomes.forEach(o => { o.no_price = 499; });
    const result = convertQuotes(raw);
    expect(result.diagnostics).toEqual([]);
    expect(result.originalYesSum).toBe(a + b + c);
    expect(result.normalizationFactor).toBe(100 / result.originalYesSum);
    expect(result.buckets.map(b => [b.yes, b.no])).toEqual(outcomes.map(o => [o.yes_price, o.no_price]));
    expect(result.buckets.reduce((s, b) => s + b.quoteShare, 0)).toBeCloseTo(1);
    expect(result.buckets.map(b => b.probability)).toEqual(result.buckets.map(b => b.quoteShare));
  });
  it.each([NaN, Infinity, -Infinity, -1])("rejects invalid YES or NO quote %s", value => {
    expect(convertQuotes(quote([value, 60, 20])).buckets).toEqual([]);
    const raw = quote(); (raw.outcomes as { no_price: number }[])[0].no_price = value;
    expect(convertQuotes(raw).buckets).toEqual([]);
  });
  it("accepts pair sums of 103 without using NO", () => {
    const raw = quote(); (raw.outcomes as { no_price: number }[])[0].no_price = 83;
    expect(convertQuotes(raw).buckets.map(b => b.quoteShare)).toEqual([.2, .6, .2]);
  });
  it("diagnoses zero totals and numeric limits without accepting silent overflow", () => {
    for (const [values, code] of [[[0, 0, 0], "zero-total"], [[Number.MAX_VALUE, Number.MAX_VALUE, 0], "numeric-overflow"], [[Number.MIN_VALUE, Number.MIN_VALUE, 0], "numeric-representability"]] as const) {
      const raw = quote([...values]); (raw.outcomes as { no_price: number }[]).forEach(o => { o.no_price = 0; });
      const result = convertQuotes(raw);
      expect(result.buckets).toEqual([]); expect(result.diagnostics.map(d => d.code)).toContain(code);
    }
  });
  it("rejects resolved, empty, missing outcomes, duplicates, and gaps", () => {
    const raw = quote(); const outcomes = raw.outcomes as { option_id: number; name: string; no_price: number }[];
    expect(convertQuotes({ ...raw, is_resolved: true }).diagnostics.map(d => d.code)).toContain("resolved");
    expect(convertQuotes({ ...raw, outcomes: [] }).buckets).toEqual([]);
    expect(convertQuotes(quote(), 4).diagnostics.some(d => d.code === "coverage")).toBe(true);
    outcomes[0].no_price = 80; outcomes[1].option_id = 1; outcomes[2].name = "3000-4000";
    expect(convertQuotes(raw).diagnostics.map(d => d.code)).toEqual(expect.arrayContaining(["duplicate", "contiguity"]));
  });
  it("computes central whole-bin interval, modal bin and boundary membership", () => {
    const bins = convertQuotes(quote()).buckets;
    expect(summarize(bins).modalBucket.optionId).toBe(2);
    expect(summarize(bins).central80).toEqual({ lower: 0, upper: 3000, probability: 1 });
    expect(thresholdProbability(bins, "above", 1000).probability).toBeCloseTo(0.8);
    expect(thresholdProbability(bins, "below", 1000).probability).toBeCloseTo(0.2);
    expect(() => thresholdProbability(bins, "above", 1500)).toThrow(/boundary/);
  });
  it("scores original multiclass bins and never chooses later forecasts", () => {
    const buckets = convertQuotes(quote()).buckets;
    expect(brier(buckets, 2)).toBeCloseTo(0.24); expect(() => brier(buckets, 99)).toThrow();
    const target = now + 7200000;
    const samples = [now + 3590000, now + 3600001, now + 7200000].map((ms, i) => ({ snapshotId: i, capturedAt: new Date(ms).toISOString(), source: "live" }) as Forecast);
    expect(selectLeadSnapshot(samples, target, 3600, 300)?.snapshotId).toBe(0);
    expect(selectLeadSnapshot(samples, target, 3600, 1)).toBeNull();
  });
});
