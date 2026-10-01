import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Projection } from "../src/components/Projection";
import { Histogram } from "../src/components/Histogram";
import { convertQuotes, summarize } from "../src/lib/forecast";
import { distributionRanges } from "../src/lib/projection";
import type { ForecastResult, TimelineResult } from "../src/lib/types";
import { market, now, quote } from "./fixtures";

const state = vi.hoisted(() => ({ values: [] as unknown[], index: 0 }));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => [state.index < state.values.length ? state.values[state.index++] : initial, () => {}],
}));
afterEach(() => { state.values = []; state.index = 0; });

function target(day: number): ForecastResult {
  const targetAt = new Date(now + day * 86400000).toISOString();
  const buckets = convertQuotes(quote([10, 80, 10]), 3).buckets;
  return { market: { ...market, cadence: "daily", topicId: day, targetAt }, status: "ready", diagnostics: [], freshUntil: new Date(now + 300000).toISOString(), forecast: { snapshotId: day, topicId: day, targetAt, capturedAt: new Date(now).toISOString(), source: "live", buckets, summary: summarize(buckets), transformationVersion: "quote-share-v1", originalYesSum: 100, normalizationFactor: 1, normalized: false, interpretation: "quote-share-not-calibrated", caveat: "" } };
}
function render(targets: ForecastResult[], horizon: 3 | 7 | 14, view = "range") {
  const timeline: TimelineResult = { cadence: "daily", asOf: new Date(now).toISOString(), collectedAt: new Date(now).toISOString(), source: "live", targets };
  state.values = [timeline, null, "", null, now, horizon, view]; state.index = 0;
  return renderToStaticMarkup(createElement(Projection, { cadence: "daily", now, offline: false, topic: null, onSelect: () => {} }));
}

describe("projection client regressions", () => {
  it("renders accessible directional weather, actual reference time and focused quote-share disclosure", () => {
    const targets = [target(1), target(2), target(3)];
    targets.forEach((result, i) => {
      const lower = [84000, 84400, 80000][i];
      const bins = [{ ...result.forecast!.buckets[0], lower, upper: lower + 200, label: `${lower}-${lower + 200}`, probability: 1 }];
      result.forecast = { ...result.forecast!, buckets: bins, summary: summarize(bins) };
    });
    const html = render(targets, 3, "heatmap");
    expect(html).toContain('aria-label="Market outlook: Steady"');
    expect(html).toContain('aria-label="Market outlook: Higher"');
    expect(html).toContain('aria-label="Market outlook: Lower"');
    expect(html).toContain("lucide-sun"); expect(html).toContain("lucide-cloud-snow");
    expect(html).toContain("Compared with"); expect(html).toContain("original median bracket $84,000 - $84,200");
    expect(html).toContain("Focused price range"); expect(html).toContain("Brighter = more likely");
    expect(html).toContain("Outside focused range"); expect(html).toContain("0.0% quote share");
    expect(html).toMatch(/fill="transparent" stroke="#ffffff"/);
    expect(html).toContain('stroke="#6cdb9a" stroke-width="3"');
    expect(html).toContain('stroke="#f47e87" stroke-width="3"');
    const stale = target(1); stale.status = "stale";
    const gaps = render([stale, targets[1]], 3);
    expect(gaps).toContain('aria-label="Market outlook: No outlook"');
    expect(gaps).toContain("lucide-cloud-off");
    expect(gaps).toContain("original median bracket $84,400 - $84,600");
    expect(gaps).not.toContain('stroke-width="3"');
  });
  // Original uncertainty-firefox-range7.png / range14.png show independent
  // settlements, not a synthetic path. Fixtures deliberately omit market dates.
  it.each([3, 7, 14] as const)("renders every requested UTC date for %s days with gray edge and interior gaps", horizon => {
    const html = render([target(2)], horizon);
    expect((html.match(/data-testid="calendar-slot"/g) ?? []).length).toBe(horizon);
    expect((html.match(/data-testid="missing-date"/g) ?? []).length).toBe(horizon - 1);
    expect((html.match(/00:00 UTC/g) ?? []).length).toBe(horizon);
    for (let day = 1; day <= horizon; day++) expect(html).toContain(`dateTime="2026-10-${String(day + 1).padStart(2, "0")}"`);
    expect(html).not.toContain('data-testid="fan-');
    expect(html).toContain('points="');
    expect(html).toContain("$1k-$2k</strong>");
    expect(html).toContain("Central 80%: $1,000 - $2,000");
    const empty = render([], horizon);
    expect((empty.match(/data-testid="missing-date"/g) ?? []).length).toBe(horizon);
  });
  it("does not connect ranges across an undiscovered date", () => {
    const html = render([target(2), target(4)], 7);
    expect((html.match(/data-testid="median-guide"/g) ?? []).length).toBe(2);
    expect(html).not.toContain('data-testid="fan-');
  });
  it("renders connected bands once without filled target bars and retains accessible interval titles", () => {
    const html = render([target(1), target(2), target(3)], 3);
    expect((html.match(/<polygon\b/g) ?? []).length).toBe(3);
    for (const band of [50, 80, 90]) expect((html.match(new RegExp(`data-testid="fan-${band}"`, "g")) ?? []).length).toBe(1);
    expect(html).not.toMatch(/<rect\b[^>]*class="fan-band /);
    expect((html.match(/data-testid="median-guide"/g) ?? []).length).toBe(1);
    const hits = [...html.matchAll(/<rect\b[^>]*fill="transparent"[^>]*tabindex="0"[^>]*role="button"[^>]*aria-label="[^"]*median range 1000-2000"[^>]*><title>([\s\S]*?)<\/title><\/rect>/g)];
    expect(hits).toHaveLength(3);
    for (const hit of hits) {
      for (const band of [50, 80, 90]) expect(hit[1]).toContain(`Central ${band}%:`);
      expect(hit[1]).toContain("Central 80%: $1,000 - $2,000; included quote share 80.0%");
    }
  });
  it("keeps three interval rectangles for a singleton", () => {
    const html = render([target(2)], 3);
    expect(html).not.toMatch(/<polygon\b/);
    expect((html.match(/<rect\b[^>]*class="fan-band /g) ?? []).length).toBe(3);
    for (const band of [50, 80, 90]) expect(html).toMatch(new RegExp(`<rect\\b[^>]*width="14"[^>]*class="fan-band band-${band}"`));
  });
  it("preserves unavailable gap shading and separates connected bands from singleton intervals", () => {
    const stale = target(3);
    stale.freshUntil = new Date(now - 1).toISOString();
    const html = render([target(1), target(2), stale, target(4)], 7);
    expect((html.match(/<polygon\b/g) ?? []).length).toBe(3);
    expect((html.match(/<rect\b[^>]*class="fan-band /g) ?? []).length).toBe(3);
    expect((html.match(/data-testid="median-guide"/g) ?? []).length).toBe(2);
    expect((html.match(/data-testid="missing-date"/g) ?? []).length).toBe(3);
    expect((html.match(/fill="#8c9599" fill-opacity=".16"/g) ?? []).length).toBe(4);
    expect((html.match(/fill="transparent"[^>]*tabindex="0"[^>]*role="button"/g) ?? []).length).toBe(4);
    expect(html).toMatch(/role="button" aria-label="[^"]*Stale or expired"/);
  });
  it("shares the selected histogram central80 with the projection and tile range", () => {
    const result = target(2);
    const buckets = result.forecast!.buckets;
    const { nominal: _, ...interval } = distributionRanges(buckets)!.bands[1];
    expect(interval).toEqual(result.forecast!.summary.central80);
    const projection = render([result], 7);
    expect(projection).toContain("$1k-$2k</strong>");
    expect(projection).toContain("Central 80%: $1,000 - $2,000; included quote share 80.0%");
    state.values = []; state.index = 0;
    const histogram = renderToStaticMarkup(createElement(Histogram, { buckets, centralRange: interval, threshold: 2000, operator: "above", onBoundary: () => {} }));
    expect((histogram.match(/class="uncertainty-band"/g) ?? []).length).toBe(1);
    expect(histogram).toContain("modal central");
  });
  it("renders decimal support to full height with exact original labels and no minimum-height overlap", () => {
    const result = target(2);
    const bins = result.forecast!.buckets.map((b, i) => ({ ...b, label: `${(i + 1) / 10}-${(i + 2) / 10}`, lower: (i + 1) / 10, upper: (i + 2) / 10 }));
    result.forecast = { ...result.forecast!, buckets: bins, summary: summarize(bins) };
    const range = render([result], 7);
    expect(range).toContain("$0.2-$0.3</strong>");
    expect(range).toContain("Central 80%: $0.2 - $0.3");
    const heatmap = render([result], 7, "heatmap");
    const cells = [...heatmap.matchAll(/data-testid="heatmap-cell"[^>]*y="([^"]+)" width="[^"]+" height="([^"]+)" fill="#[a-f0-9]+" fill-opacity=/g)].map(m => ({ y: Number(m[1]), height: Number(m[2]) }));
    expect(cells).toHaveLength(3);
    expect(cells.reduce((sum, c) => sum + c.height, 0)).toBeCloseTo(242);
    expect(Math.min(...cells.map(c => c.y))).toBeCloseTo(28);
    expect(Math.max(...cells.map(c => c.y + c.height))).toBeCloseTo(270);
    cells.sort((a, b) => a.y - b.y);
    for (let i = 1; i < cells.length; i++) expect(cells[i - 1].y + cells[i - 1].height).toBeCloseTo(cells[i].y);
  });
});
