import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Projection } from "../src/components/Projection";
import { Histogram } from "../src/components/Histogram";
import { convertQuotes, summarize } from "../src/lib/forecast";
import { distributionRanges } from "../src/lib/projection";
import type { ForecastResult, TimelineResult, TimelineTarget } from "../src/lib/types";
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
function observation(value = 85000): TimelineTarget {
  const targetAt = new Date(now).toISOString();
  return { kind: "past", targetAt, market: null, forecast: null, status: "unavailable", diagnostics: [], observed: { source: "Kraken", pair: "XBTUSD", cadence: "daily", interval: 1440, value, candleStart: new Date(now - 86400000).toISOString(), candleEnd: targetAt, fetchedAt: targetAt } };
}
function render(targets: TimelineTarget[], horizon: 3 | 7 | 14, view = "range", cadence: "daily" | "hourly" = "daily", topic: number | null = null) {
  const timeline: TimelineResult = { cadence, asOf: new Date(now).toISOString(), collectedAt: new Date(now).toISOString(), source: "live", targets };
  state.values = [timeline, null, "", null, now, horizon, view]; state.index = 0;
  return renderToStaticMarkup(createElement(Projection, { cadence, now, offline: false, topic, onSelect: () => {} }));
}

describe("projection client regressions", () => {
  it.each(["range", "heatmap"])("retains observed historical direction and unavailable sentiment in %s", view => {
    const older = observation(84000);
    older.targetAt = new Date(now - 86400000).toISOString();
    older.observed = { ...older.observed!, candleEnd: older.targetAt, candleStart: new Date(now - 2 * 86400000).toISOString() };
    const html = render([older, observation(85000), target(1)], 3, view);
    expect(html).toContain('style="color:var(--positive)">Rising</span>');
    expect(html).toContain('aria-label="Rising"');
    const missing = render([target(1)], 3, view);
    expect(missing).toContain('aria-label="Sentiment unavailable"');
    expect(missing).toContain('style="color:var(--stale)">\u2014</span>');
    expect(missing).not.toContain(">Mixed</span>");
  });
  it("keeps sentiment and icons stable when modal and median guides disagree", () => {
    const targets = [target(1), target(2)];
    targets.forEach((r, j) => {
      const bins = Array.from({ length: 5 }, (_, i) => ({ ...r.forecast!.buckets[0], lower: 84000 + i * 200, upper: 84200 + i * 200, probability: (j ? [.4, 0, 0, .35, .25] : [0, .25, .4, .35, 0])[i] }));
      r.forecast = { ...r.forecast!, buckets: bins, summary: summarize(bins) };
    });
    const html = ["range", "heatmap"].map(view => render([observation(84300), ...targets], 3, view));
    const sentiments = (markup: string) => [...markup.matchAll(/data-kind="future"[^>]*aria-label="([^"]*)"/g)].map(m => m[1].split(", ").filter(s => /^(Bullish|Bearish|Mixed|reference |quote weight |below |undecided )/.test(s)));
    expect(sentiments(html[0])).toEqual(sentiments(html[1]));
    expect(html[0]).toContain('data-direction="higher" class="forecast-column outlook-sunny"');
    expect(html[1]).toContain('data-direction="lower" class="forecast-column outlook-sunny"');
    expect(html.every(h => h.includes('style="color:var(--positive)">Bullish</span>'))).toBe(true);
  });
  it.each(["range", "heatmap"])("shows Mixed amber and Bearish red with independent wind priority in %s", view => {
    const mixed = target(1), bearish = target(2);
    const bs = [{ ...mixed.forecast!.buckets[0], lower: 84000, upper: 84200, probability: 1 }];
    mixed.forecast = { ...mixed.forecast!, buckets: bs, summary: summarize(bs) };
    const wide = [{ ...bs[0], lower: 70000, upper: 80000 }];
    bearish.forecast = { ...bearish.forecast!, buckets: wide, summary: summarize(wide) };
    const html = render([observation(84100), mixed, bearish], 3, view);
    expect(html).toContain('style="color:var(--chart-primary)">Mixed</span>');
    expect(html).toContain('aria-label="Mixed"');
    expect(html).toContain("lucide-cloud-sun");
    expect(html).toContain('style="color:var(--negative)">Bearish<small');
    expect(html).toContain('aria-label="Bearish, Wide range"');
    expect(html).toContain("lucide-wind");
  });
  it("draws a real fixed-lead past band after its freshness deadline, without an observation or future actual", () => {
    const historical = target(0) as TimelineTarget;
    historical.kind = "past"; historical.targetAt = historical.market!.targetAt;
    historical.forecast = { ...historical.forecast!, capturedAt: new Date(now - 86400000 - 1000).toISOString() };
    historical.freshUntil = new Date(now - 86400000 + 299000).toISOString();
    historical.archive = { snapshotId: historical.forecast.snapshotId, leadSeconds: 86400, maxSnapshotAgeSeconds: 300, cutoff: new Date(now - 86400000).toISOString() };
    const html = render([historical, target(1)], 3);
    expect(html).not.toContain("Archives:");
    expect(html).not.toContain("Archived $1k-$2k");
    expect((html.match(/<polygon\b/g) ?? [])).toHaveLength(3);
    expect(html).not.toMatch(/<rect\b[^>]*class="fan-band /);
    expect(html).not.toContain('data-testid="observed-price"');
    expect(html).not.toContain('data-testid="forecast-transition"');
  });
  it("bridges archived and future bands once while actual history stays solid at observed values", () => {
    const past = (day: number, value: number): TimelineTarget => {
      const result = target(day) as TimelineTarget;
      result.kind = "past"; result.targetAt = result.market!.targetAt;
      const capturedAt = new Date(now + (day - 1) * 86400000 - 1000).toISOString();
      result.forecast = { ...result.forecast!, capturedAt };
      result.archive = { snapshotId: result.forecast.snapshotId, leadSeconds: 86400, maxSnapshotAgeSeconds: 300, cutoff: new Date(now + (day - 1) * 86400000).toISOString() };
      result.observed = { source: "Kraken", pair: "XBTUSD", cadence: "daily", interval: 1440, value, candleStart: new Date(now + (day - 1) * 86400000).toISOString(), candleEnd: result.targetAt, fetchedAt: new Date(now).toISOString() };
      return result;
    };
    const targets = [past(-1, 1200), past(0, 1250), target(1), target(2)];
    const html = render(targets, 3);
    expect((html.match(/<polygon\b/g) ?? [])).toHaveLength(3);
    expect(html).not.toMatch(/<rect\b[^>]*class="fan-band /);
    expect((html.match(/data-testid="observed-price"/g) ?? [])).toHaveLength(2);
    expect(html).toMatch(/y1="176\.8"[^>]*y2="172\.33333333333331"[^>]*stroke="var\(--ink\)" stroke-width="3" data-testid="observed-segment"/);
    expect(html).toContain('stroke-dasharray="6 5" data-testid="forecast-transition"');
    expect((html.match(/data-testid="guide-direction"/g) ?? [])).toHaveLength(1);
    const missing = render([targets[0], { ...targets[1], forecast: null, archive: undefined }, ...targets.slice(2)], 3);
    expect((missing.match(/<polygon\b/g) ?? [])).toHaveLength(3);
    expect((missing.match(/<rect\b[^>]*class="fan-band /g) ?? [])).toHaveLength(3);
    expect(missing).toContain('data-testid="observed-segment"');
    expect(missing).toContain('data-testid="forecast-transition"');
  });
  it("plots actual-only history before the divider and a dashed future transition without synthetic bands", () => {
    const past = (days: number, value: number): TimelineTarget => {
      const targetAt = new Date(now - days * 86400000).toISOString();
      return { kind: "past", targetAt, market: null, forecast: null, status: "unavailable", diagnostics: [], observed: { source: "Kraken", pair: "XBTUSD", cadence: "daily", interval: 1440, value, candleStart: new Date(now - (days + 1) * 86400000).toISOString(), candleEnd: targetAt, fetchedAt: new Date(now).toISOString() } };
    };
    const html = render([past(1, 1200), past(0, 1250), target(1)], 3);
    expect((html.match(/data-kind="past"/g) ?? [])).toHaveLength(2);
    expect(html).toContain('data-testid="now-divider"');
    expect(html).toContain('data-testid="observed-segment"');
    expect(html).toContain('stroke-dasharray="6 5" data-testid="forecast-transition"');
    expect(html).not.toContain("No archived forecast");
    expect(html).not.toContain('data-testid="fan-');
    expect(html).not.toContain("not exact Glimpse settlement prices");
    expect(html).not.toMatch(/<(details|summary)\b/);
    expect(html).not.toContain('href="https://api.kraken.com');
    expect(html).not.toContain('class="projection-detail"');
    const gap = render([{ ...past(1, 1200), observed: undefined }, past(0, 1250), target(1)], 3);
    expect(gap).not.toContain('data-testid="observed-segment"');
    const component = readFileSync(new URL("../src/components/Projection.tsx", import.meta.url), "utf8");
    expect(component).toContain("firstFuture.getBoundingClientRect().left - scroll.current.getBoundingClientRect().left");
    expect(component).toContain('const selection = `${cadence}:${horizon}`');
    expect(component).toContain("initialScroll.current === selection");
    expect(html).not.toContain("no backfill");
    expect(component).toContain("data.cadence === cadence");
    expect(component).toContain("initialScroll.current = null");
    expect(component).toContain("onHistorical?.(column.result.archive.snapshotId)");
  });
  it.each(["range", "heatmap"])("uses only a subtle shadow on each 3px directional %s line without outline strokes", view => {
    const targets = [target(1), target(2), target(3)];
    targets.forEach((result, i) => {
      const lower = [84000, 84400, 84000][i];
      const bins = [{ ...result.forecast!.buckets[0], lower, upper: lower + 200, probability: 1 }];
      result.forecast = { ...result.forecast!, buckets: bins, summary: summarize(bins) };
    });
    const html = render(targets, 3, view);
    expect((html.match(/data-testid="guide-segment"/g) ?? [])).toHaveLength(2);
    expect((html.match(/data-testid="guide-direction"/g) ?? [])).toHaveLength(2);
    expect((html.match(/data-testid="guide-segment"><line\b[^>]*><\/line><\/g>/g) ?? [])).toHaveLength(2);
    expect(html).not.toContain("projection-guide-halo");
    expect(html).not.toMatch(/stroke-width="[57]"/);
    expect(html).toContain('stroke="var(--positive)" stroke-width="3"');
    expect(html).toContain('stroke="var(--negative)" stroke-width="3"');
    expect(html).toContain(view === "range" ? 'role="img" aria-label="Whole-bin central' : 'role="group" aria-label="Quote-share heatmap');
    if (view === "heatmap") {
      expect(html.indexOf('class="heatmap-labels"')).toBeGreaterThan(html.indexOf('data-testid="guide-direction"'));
      expect(html).toContain('width="50" height="18" rx="3" fill="var(--weight-plate)"');
    }
    const styles = readFileSync(new URL("../src/app/globals.scss", import.meta.url), "utf8");
    expect(styles).toContain(".heatmap-labels { pointer-events: none; }");
    expect(styles).toContain(".projection-guide-direction { filter: drop-shadow(0 1px 1.5px var(--guide-shadow)); }");
    expect(styles).not.toContain("projection-guide-halo");
    expect(styles).toContain("stroke-linecap: round; stroke-linejoin: round;");
    expect(styles).toContain(".heatmap-share { fill: var(--ink); stroke: var(--weight-plate); }");
    expect(styles).toContain("stroke-width: 3px; paint-order: stroke");
  });
  it("keeps the compact accessible horizon rightmost in one toolbar row", () => {
    const html = render([target(1)], 3);
    expect(html).toContain('aria-label="Forecast horizon"');
    const styles = readFileSync(new URL("../src/app/globals.scss", import.meta.url), "utf8");
    expect(styles).toMatch(/\.projection-controls \{[^}]*display: flex[^}]*flex-wrap: nowrap/);
    expect(html.indexOf('aria-label="Projection view"')).toBeLessThan(html.indexOf('class="projection-horizon"'));
    expect(styles).toMatch(/\.projection-controls label \{[^}]*flex-shrink: 0/);
    expect(styles).toMatch(/\.projection-controls select \{[^}]*width: 52px; min-height: 44px/);
    expect(styles).toContain(".projection-controls .projection-horizon { margin-left: auto; }");
    expect(styles).not.toMatch(/\.projection-controls \{[^}]*display: grid/);
  });
  it.each(["daily", "hourly"] as const)("shows compact %s units with full accessible option names and unchanged values", cadence => {
    const unit = cadence === "daily" ? "d" : "h", fullUnit = cadence === "daily" ? "days" : "hours";
    for (const horizon of [3, 7, 14] as const) {
      const html = render([], horizon, "range", cadence);
      for (const value of [3, 7, 14]) {
        expect(html).toContain(`aria-label="${value} ${fullUnit}" title="${value} ${fullUnit}"${value === horizon ? ' selected=""' : ""}>${value}${unit}</option>`);
      }
      expect(html).toContain(`value="${horizon}"`);
      expect(html).not.toContain(`>${horizon} ${fullUnit}</option>`);
    }
  });
  it.each(["range", "heatmap"])("keeps a Bullish %s tile green independently of the previous forecast", view => {
    const targets = [target(1), target(2), target(3)];
    targets.forEach((result, i) => {
      const midpoint = [86000, 85500, 86100][i];
      const bins = [{ ...result.forecast!.buckets[0], lower: midpoint - 50, upper: midpoint + 50, label: `${midpoint - 50}-${midpoint + 50}`, probability: 1 }];
      result.forecast = { ...result.forecast!, buckets: bins, summary: summarize(bins) };
    });
    const html = render([observation(), ...targets], 3, view);
    expect(html).toContain('data-direction="higher" class="forecast-column outlook-sunny"');
    expect(html).toContain('style="color:var(--positive)">Bullish</span>');
    expect(html).toContain('stroke="var(--positive)" stroke-width="3"');
    expect(html).toContain('data-direction="lower" class="forecast-column outlook-sunny"');
    const gap = render([targets[0], targets[2]], 3, view);
    expect(gap).not.toContain('data-direction="higher"');
    expect(gap).not.toContain('stroke-width="3"');
  });
  it("retains Bullish alongside the wide-range icon without changing fixed header dimensions", () => {
    const targets = [target(1), target(2)];
    targets.forEach((result, i) => {
      const lower = 84000 + i * 1000;
      const bins = [{ ...result.forecast!.buckets[0], lower, upper: lower + 8000, probability: 1 }];
      result.forecast = { ...result.forecast!, buckets: bins, summary: summarize(bins) };
    });
    const html = render([observation(83000), ...targets], 3);
    expect(html).toContain('data-direction="higher" class="forecast-column outlook-windy"');
    expect(html).toContain('style="color:var(--positive)">Bullish');
    expect(html).toContain('aria-label="Bullish, Wide range"');
    expect(html).toContain('stroke="var(--positive)" stroke-width="3"');
  });
  it.each(["range", "heatmap"].flatMap(view => (["stale", "invalid", "unavailable", "expired"] as const).map(status => ({ view, status }))))("hides the dummy price domain for $status $view forecasts and retains capture evidence", ({ view, status }) => {
    const stale = target(1); stale.status = status;
    const html = render([stale], 3, view);
    expect(html).toContain("Unavailable");
    expect(html).not.toContain("Last captured");
    expect(html).toContain(`dateTime="${stale.forecast!.capturedAt}"`);
    expect(html).toContain("Retry</button>");
    expect(html).not.toContain('class="projection-price-axis"');
    expect(html).not.toContain('class="forecast-range-plot"');
    expect(html).not.toContain('class="grid-line"');
  });
  it("keeps responsive columns, a tall plot and transparent selection with an overflow-only fade", () => {
    const styles = readFileSync(new URL("../src/app/globals.scss", import.meta.url), "utf8");
    expect(styles).toContain("--forecast-column-width: 160px");
    expect(styles).toContain("--forecast-column-width: 180px");
    expect(styles).toContain("--forecast-header-height: 120px");
    expect(styles).toContain("--forecast-plot-height: 300px");
    expect(styles).toMatch(/\.forecast-columns \{[^}]*height: calc\(var\(--forecast-header-height\) \+ var\(--forecast-plot-height\)\)/);
    expect(styles).toMatch(/\.forecast-range-plot \{[^}]*top: var\(--forecast-header-height\)[^}]*height: var\(--forecast-plot-height\)/);
    expect(styles).toMatch(/\.forecast-column \{[^}]*background: transparent/);
    expect(styles).toMatch(/\.forecast-column\[aria-pressed=true\] \{ box-shadow:[^}]*\}/);
    expect(styles).toContain(".forecast-strip[data-more=true] .projection-scroll { mask-image:");
    expect(styles).toMatch(/\.projection-scroll \{[^}]*overflow-x: auto[^}]*scrollbar-width: none/);
    expect(styles).toContain(".projection-scroll:focus-visible");
    expect(styles).not.toContain(".daily-tiles");
  });
  it("fits shorter mobile viewports without shrinking headers or desynchronizing the price scale", () => {
    const styles = readFileSync(new URL("../src/app/globals.scss", import.meta.url), "utf8");
    expect(styles).toContain("@media (max-width: 799px) and (max-height: 850px)");
    expect(styles).toMatch(/\.projection-controls \{[^}]*display: flex[^}]*flex-wrap: nowrap/);
    expect(styles).toContain("clamp(250px, calc(100dvh - 468px - env(safe-area-inset-top) - env(safe-area-inset-bottom)), 300px)");
    expect(styles).toMatch(/\.projection-price-axis svg \{[^}]*margin-top: var\(--forecast-header-height\)[^}]*height: var\(--forecast-plot-height\)/);
    expect(styles).toMatch(/\.forecast-column \{[^}]*height: calc\(var\(--forecast-header-height\) \+ var\(--forecast-plot-height\)\)/);
    const html = render([target(1), target(2)], 3);
    expect(html).toContain('width="52" height="300" viewBox="0 0 52 300" preserveAspectRatio="none"');
    expect(html).toContain('x="46"');
    expect(html).toContain('viewBox="0 0 540 300" preserveAspectRatio="none"');
  });
  it.each(["range", "heatmap"])("keeps the compact %s axis width shared with its SVG and exact price titles", view => {
    const styles = readFileSync(new URL("../src/app/globals.scss", import.meta.url), "utf8");
    expect(styles).toContain("--axis-width: 52px");
    expect(styles).toContain("--axis-width: 60px");
    expect(styles).toMatch(/\.projection-price-axis \{[^}]*flex: 0 0 var\(--axis-width\); width: var\(--axis-width\)/);
    expect(styles).toMatch(/\.projection-price-axis svg \{[^}]*width: var\(--axis-width\)/);
    const result = target(1);
    const bins = [{ ...result.forecast!.buckets[0], lower: 94400, upper: 125000, probability: 1 }];
    result.forecast = { ...result.forecast!, buckets: bins, summary: summarize(bins) };
    const html = render([result], 3, view);
    expect(html).toContain('<title>$94,400</title>$94.4K</text>');
    expect(html).toContain('<title>$125,000</title>$125K</text>');
    expect(html).not.toContain('viewBox="0 0 72 300"');
  });
  it.each(["range", "heatmap"])("keeps one compact accessible %s legend above the unified strip", view => {
    const html = render([target(1), target(2)], 3, view);
    expect((html.match(/class="projection-legend"/g) ?? []).length).toBe(1);
    expect(html.indexOf('class="projection-controls"')).toBeLessThan(html.indexOf('class="projection-legend"'));
    expect(html.indexOf('class="projection-legend"')).toBeLessThan(html.indexOf('class="forecast-strip"'));
    expect(html).toMatch(/class="projection-legend" role="group" aria-label="[^"]+"/);
    expect(html).not.toContain("Independent forecasts, not a joint price path");
    expect(html).not.toMatch(/<(details|summary|table)\b/);
    if (view === "range") {
      for (const band of [50, 80, 90]) expect(html).toContain(`aria-hidden="true"></i>${band}%`);
      expect(html).toContain("Median</span>");
    } else {
      expect(html).toContain("Red below reference, green above; brighter means more weight");
    }
    const styles = readFileSync(new URL("../src/app/globals.scss", import.meta.url), "utf8");
    expect(styles).toMatch(/\.projection-legend \{[^}]*min-height: 18px[^}]*line-height: 18px/);
    expect(styles).toContain(".outlook:has(.projection) .outlook-meta { margin-block: 4px 2px; }");
    expect(styles).toContain(".projection .section-heading { margin-bottom: 4px; }");
  });
  it("renders accessible sentiment weather, observed reference time and quote weights", () => {
    const targets = [target(1), target(2), target(3)];
    targets.forEach((result, i) => {
      const lower = [84000, 84400, 80000][i];
      const bins = [{ ...result.forecast!.buckets[0], lower, upper: lower + 200, label: `${lower}-${lower + 200}`, probability: 1 }];
      result.forecast = { ...result.forecast!, buckets: bins, summary: summarize(bins) };
    });
    const html = render([observation(84300), ...targets], 3, "heatmap");
    expect(html).toContain('aria-label="Bullish"');
    expect(html).toContain('aria-label="Bearish"');
    expect(html).toContain("reference $84,300 at");
    expect(html).toContain("quote weight above 100.0%, below 0.0%, undecided 0.0%");
    expect(html).toContain("lucide-sun"); expect(html).toContain("lucide-cloud-rain");
    expect(html).toContain("Reference $84k-$84.2k");
    expect(html).not.toContain("More market weight");
    expect(html).not.toContain("Quote share per price band");
    expect(html).not.toContain("Outside focus:");
    expect(html).toContain('class="forecast-column outlook-rainy"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('stroke="var(--ink)"');
    expect(html).toContain('stroke="var(--positive)" stroke-width="3"');
    expect(html).toContain('stroke="var(--negative)" stroke-width="3"');
    expect(html).toContain('aria-label="Actual, solid line"><i class="actual-line-key" aria-hidden="true"></i>Actual');
    expect(html).toContain('aria-label="Forecast, dashed line"><i class="forecast-line-key" aria-hidden="true"></i>Forecast');
    expect(html).not.toMatch(/Actual \(solid\)|Forecast \(dashed\)/);
    expect(html).toContain("Reference");
    const stale = target(1); stale.status = "stale";
    const gaps = render([stale, targets[1]], 3);
    expect(gaps).toContain('aria-label="Sentiment unavailable"');
    expect(gaps).toContain("lucide-cloud-off");
    expect(gaps).not.toContain("Kraken");
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
    expect(empty).toContain("Unavailable");
    expect(empty).not.toContain('class="projection-price-axis"');
    expect(empty).not.toContain('class="forecast-range-plot"');
  });
  it("does not connect ranges across an undiscovered date", () => {
    const html = render([target(2), target(4)], 7);
    expect((html.match(/data-testid="median-guide"/g) ?? []).length).toBe(2);
    expect(html).not.toContain('data-testid="fan-');
  });
  it("renders connected bands once without filled target bars or technical tile hover titles", () => {
    const html = render([target(1), target(2), target(3)], 3);
    expect((html.match(/<polygon\b/g) ?? []).length).toBe(3);
    for (const band of [50, 80, 90]) expect((html.match(new RegExp(`data-testid="fan-${band}"`, "g")) ?? []).length).toBe(1);
    expect(html).not.toMatch(/<rect\b[^>]*class="fan-band /);
    expect((html.match(/data-testid="median-guide"/g) ?? []).length).toBe(1);
    const hits = [...html.matchAll(/<button\b[^>]*aria-label="[^"]*median range 1000-2000"[^>]*>/g)];
    expect(hits).toHaveLength(3);
    for (const hit of hits) expect(hit[0]).not.toContain("title=");
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
    expect((html.match(/fill="var\(--stale\)" fill-opacity=".16"/g) ?? []).length).toBe(4);
    expect((html.match(/<button\b[^>]*class="forecast-column [^>]*aria-label=/g) ?? []).length).toBe(7);
    expect(html).toMatch(/aria-label="[^"]*Stale or expired, Sentiment unavailable"/);
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
    const cells = [...heatmap.matchAll(/data-testid="heatmap-cell"[^>]*y="([^"]+)" width="[^"]+" height="([^"]+)" fill="var\(--[a-z-]+\)" fill-opacity=/g)].map(m => ({ y: Number(m[1]), height: Number(m[2]) }));
    expect(cells).toHaveLength(3);
    expect(cells.reduce((sum, c) => sum + c.height, 0)).toBeCloseTo(268);
    expect(Math.min(...cells.map(c => c.y))).toBeCloseTo(16);
    expect(Math.max(...cells.map(c => c.y + c.height))).toBeCloseTo(284);
    cells.sort((a, b) => a.y - b.y);
    for (let i = 1; i < cells.length; i++) expect(cells[i - 1].y + cells[i - 1].height).toBeCloseTo(cells[i].y);
  });
  it("uses one shared plot inside a single strip with a fixed price axis and no second tile row", () => {
    const html = render([target(1), target(2), target(3)], 7);
    expect((html.match(/class="projection-scroll"/g) ?? []).length).toBe(1);
    expect((html.match(/class="forecast-range-plot"/g) ?? []).length).toBe(1);
    expect(html.indexOf('class="projection-price-axis"')).toBeLessThan(html.indexOf('class="projection-scroll"'));
    expect(html).toContain('tabindex="0" role="region" aria-label="Daily forecast and price ranges"');
    expect(html).toContain('style="width:calc(7 * var(--forecast-column-width))"');
    expect(html).toContain('viewBox="0 0 1260 300"');
    expect(html).not.toContain('class="daily-tiles"');
    expect(html).not.toContain('class="day-tile');
  });
  it("retains hourly calendar gaps without drawing a path through a missing settlement", () => {
    const targets = [1, 3].map(hour => {
      const result = target(hour);
      const targetAt = new Date(now + hour * 3600000).toISOString();
      return { ...result, market: { ...result.market!, cadence: "hourly" as const, targetAt }, forecast: { ...result.forecast!, targetAt } };
    });
    const html = render(targets, 3, "range", "hourly");
    expect((html.match(/data-testid="calendar-slot"/g) ?? []).length).toBe(3);
    expect((html.match(/data-testid="missing-date"/g) ?? []).length).toBe(1);
    expect(html).not.toContain('data-testid="fan-');
    expect(html).not.toContain('stroke-width="3"');
    expect(html).toContain('aria-label="Hourly forecast and price ranges"');
  });
  it("shows the exact modal bracket in heatmap headers and selected detail rather than the median", () => {
    const result = target(1);
    const bins = result.forecast!.buckets.map((b, i) => ({ ...b, probability: [.4, .35, .25][i] }));
    result.forecast = { ...result.forecast!, buckets: bins, summary: summarize(bins) };
    const html = render([result, target(2)], 3, "heatmap", "daily", result.market!.topicId);
    expect(html).toContain('modal range 0-1000');
    expect(html).toContain('$0-$1k</strong>');
    expect(html).toContain('>Modal range</span>');
    expect(html).not.toContain('>Median range</span>');
  });
  it("omits zero-share rectangles entirely and gives nonzero cells one roving focus target", () => {
    const targets = [target(1), target(2)];
    targets.forEach(result => {
      const bins = result.forecast!.buckets.map((b, i) => ({ ...b, probability: [0, .99999, .00001][i] }));
      result.forecast = { ...result.forecast!, buckets: bins, summary: summarize(bins) };
    });
    const html = render(targets, 3, "heatmap");
    const cells = [...html.matchAll(/<rect data-testid="heatmap-cell"[^>]*>/g)].map(m => m[0]);
    expect(cells).toHaveLength(4);
    expect(cells.filter(c => c.includes('tabindex="0"'))).toHaveLength(1);
    expect(cells.filter(c => c.includes('tabindex="-1"'))).toHaveLength(3);
    expect(cells.every(c => c.includes('role="button"') && c.includes("quote share"))).toBe(true);
    expect(html).toContain("&lt;0.1% quote share");
    expect(html).toContain('class="heatmap-share"');
    expect(html).toContain('class="heatmap-inspection" aria-live="polite" role="status"');
    expect(html).not.toContain('fill="transparent" stroke="none"');
  });
  it("restricts only heatmap header hit areas and makes cells active without guide interception", () => {
    const styles = readFileSync(new URL("../src/app/globals.scss", import.meta.url), "utf8");
    expect(styles).toContain(".forecast-strip[data-view=heatmap] .forecast-range-plot { pointer-events: auto; }");
    expect(styles).toContain(".forecast-strip[data-view=heatmap] .forecast-column { height: var(--forecast-header-height); }");
    expect(styles).toContain(".projection-guide, .heatmap-selection, .heatmap-share { pointer-events: none; }");
    expect(styles).toContain(".forecast-strip[data-view=heatmap] .projection-scroll { mask-image: none; }");
    expect(styles).toContain("font-size: 12px; font-weight: 600;");
    const source = readFileSync(new URL("../src/components/Projection.tsx", import.meta.url), "utf8");
    expect(source).toContain("nextHeatmapCell(columns, model.rows");
    expect(source).toContain('e.key === "Enter" || e.key === " "');
    expect(source).toContain("onClick={() => inspectCell(i, r)}");
    expect(source).toContain("onMouseEnter={() => inspectCell(i, r)}");
  });
  it("labels the selected focus range, retains the original reference, and discloses fallback", () => {
    const targets = [target(1), target(2)];
    targets.forEach((result, i) => {
      const lower = 84000 + i * 2000;
      const bins = [{ ...result.forecast!.buckets[0], lower, upper: lower + 200, probability: 1 }];
      result.forecast = { ...result.forecast!, buckets: bins, summary: summarize(bins) };
    });
    const html = render(targets, 3, "heatmap", "daily", 2);
    expect(html).toContain("$86k-$86.2k");
    expect(html).toContain("Reference $84k-$84.2k");
    expect(html).toContain("100.0% quote share");
    targets[1].status = "stale";
    const fallback = render(targets, 3, "heatmap", "daily", 2);
    expect(fallback).not.toContain("Selected target unavailable; first valid target");
    expect(fallback).toContain("$84k-$84.2k");
  });
});
