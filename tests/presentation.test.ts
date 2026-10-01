import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Histogram, coverageLabel, defaultBoundary } from "../src/components/Histogram";
import { boundaryProbability, canonicalBoundary, currentForecastResult, ForecastHeadline, WeatherApp } from "../src/components/WeatherApp";
import { isDisableOnly } from "../src/components/Watches";
import { market, now, watch } from "./fixtures";
import type { Watch } from "../src/lib/types";
import type { Bucket, ForecastResult } from "../src/lib/types";

describe("compact forecast presentation", () => {
  it("ages a ready forecast locally while a foreground refresh is pending", () => {
    const result = { market, status: "ready", diagnostics: [], freshUntil: new Date(now + 120000).toISOString(), forecast: { targetAt: market.targetAt } } as unknown as ForecastResult;
    expect(currentForecastResult(result, now + 120000)?.status).toBe("ready");
    expect(currentForecastResult(result, now + 120001)?.status).toBe("stale");
    expect(currentForecastResult(result, now + 7200000)?.status).toBe("expired");
    expect(currentForecastResult({ ...result, freshUntil: undefined }, now)?.status).toBe("stale");
    expect(currentForecastResult({ ...result, freshUntil: "invalid" }, now)?.status).toBe("stale");
    expect(currentForecastResult(result, null)?.status).toBe("stale");
    expect(currentForecastResult({ ...result, status: "invalid" }, now)?.status).toBe("invalid");
  });

  it("allows disabling in the edit form without accepting condition edits or new watches", () => {
    const saved = { ...watch, id: "saved", createdAt: "saved", baseline: null, lastNotifiedAt: null } satisfies Watch;
    expect(isDisableOnly(saved, { ...watch, enabled: false })).toBe(true);
    expect(isDisableOnly(saved, watch)).toBe(false);
    expect(isDisableOnly(null, { ...watch, enabled: false })).toBe(false);
    expect(isDisableOnly(saved, { ...watch, enabled: false, threshold: 1000 })).toBe(false);
  });
  it("starts with an honest loading state and one forecast Details action", () => {
    const html = renderToStaticMarkup(createElement(WeatherApp));
    expect(html).toContain("Checking the forecast");
    expect(html).toContain("Getting market quotes...");
    expect(html).toContain("Forecast details");
    expect(html).toContain("lucide-cloud");
    expect(html).not.toContain("weather-mark.png");
    expect(html).not.toContain("Awaiting a validated quote distribution");
    expect(html).not.toContain("failed checks /");
    expect(html).not.toContain("Settlement (UTC)");
  });

  it("focuses on real central bins without rescaling their probabilities", () => {
    const buckets: Bucket[] = Array.from({ length: 10 }, (_, i) => ({
      optionId: i + 1, label: `${i * 1000}-${(i + 1) * 1000}`, lower: i * 1000,
      upper: (i + 1) * 1000, yes: i === 5 ? 100 : 0, no: i === 5 ? 0 : 100,
      probability: i === 5 ? 1 : 0, quoteShare: i === 5 ? 1 : 0,
    }));
    const html = renderToStaticMarkup(createElement(Histogram, {
      buckets, centralRange: { lower: 5000, upper: 6000 }, threshold: 5000,
      operator: "above", onBoundary: () => {},
    }));
    expect((html.match(/class="bar /g) ?? []).length).toBe(5);
    expect(html).toContain("$5,000 to $6,000: 100.0% quote share");
    expect(html).toContain('height="0"');
    expect(html).not.toContain("Full range");
    expect(html).not.toContain("Focused range");
    expect(html).not.toContain('type="range"');
    expect(html).toContain("Lower price");
    expect(html).toContain("Higher price");
    expect(html).toContain("Most likely");
    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-label="Chart price boundary"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="10000"');
    expect(html).toContain('aria-valuenow="5000"');
    expect(html).toContain('aria-valuetext="above $5,000"');
    expect(html).toContain("modal central");
    expect(html).not.toContain("Central 80%");
    expect(html).not.toContain('rx="3"');
  });

  const bins: Bucket[] = [
    { optionId: 1, label: "0-1000", lower: 0, upper: 1000, yes: 20, no: 80, probability: .2, quoteShare: .2 },
    { optionId: 2, label: "1000-3000", lower: 1000, upper: 3000, yes: 60, no: 40, probability: .6, quoteShare: .6 },
    { optionId: 3, label: "3000-4000", lower: 3000, upper: 4000, yes: 20, no: 80, probability: .2, quoteShare: .2 },
  ];

  it("labels whole-bin coverage with its actual share", () => {
    expect(coverageLabel(.8)).toBe("80% of market forecast");
    expect(coverageLabel(.92)).toBe("92% of market forecast");
    expect(coverageLabel(.837)).toBe("83.7% of market forecast");
    expect(coverageLabel(1)).toBe("100% of market forecast");
  });

  it("leads with the real median bracket, not an invented point price", () => {
    const forecast = { buckets: bins, summary: { modalBucket: bins[1] } } as NonNullable<ForecastResult["forecast"]>;
    const html = renderToStaticMarkup(createElement(ForecastHeadline, { forecast }));
    expect(html).toContain("Median range");
    expect(html).toContain("$1,000");
    expect(html).toContain("$3,000");
    expect(html).not.toContain("$2,000");
    expect(html).not.toContain("quote share");
  });

  it("defaults to the modal upper boundary rather than the zero tail", () => {
    expect(defaultBoundary(bins)).toBe(3000);
    expect(defaultBoundary([...bins].reverse())).toBe(3000);
    expect(defaultBoundary([])).toBe(0);
  });

  it("only computes whole-bin chances at canonical offered boundaries", () => {
    expect(boundaryProbability(bins, 1500, "above")).toBeNull();
    expect(boundaryProbability(bins, 1500, "below")).toBeNull();
    for (const value of [NaN, Infinity, -Infinity, 1000.00001]) expect(canonicalBoundary(bins, value)).toBeNull();
    expect(canonicalBoundary(bins, 1000 + 1e-10)).toBe(1000);
    expect(boundaryProbability(bins, 1000 + 1e-10, "above")).toBeCloseTo(.8);
    expect(boundaryProbability(bins, 1000 - 1e-10, "below")).toBeCloseTo(.2);
  });

  it("uses actual bucket widths and heights with opposite above/below shading", () => {
    const render = (operator: "above" | "below") => renderToStaticMarkup(createElement(Histogram, {
      buckets: bins, centralRange: { lower: 1000, upper: 3000 }, threshold: 3000,
      operator, onBoundary: () => {},
    }));
    expect(render("above")).toContain('class="selection-band" x="525" y="30" width="155"');
    expect(render("below")).toContain('class="selection-band" x="60" y="30" width="465"');
    expect(render("above")).toContain('class="column" x="215" y="50" width="310" height="190"');
    expect(render("above")).toContain('$1,000 to $3,000: 60.0% quote share');
    expect(render("below")).toContain('aria-valuetext="below $3,000"');
  });

  it("expands only toward an offered boundary outside the central view", () => {
    const buckets = Array.from({ length: 20 }, (_, i) => ({ ...bins[0], optionId: i, lower: i * 1000, upper: (i + 1) * 1000, probability: i === 10 ? .8 : .2 / 19 }));
    const html = renderToStaticMarkup(createElement(Histogram, {
      buckets, centralRange: { lower: 10000, upper: 11000 }, threshold: 20000,
      operator: "below", onBoundary: () => {},
    }));
    expect((html.match(/class="bar /g) ?? []).length).toBe(12);
    expect(html).toContain("8.4% outside shown range");
    expect(html).not.toContain("Full range");
    expect(html).toContain('aria-valuemax="20000"');
    expect(html).toContain('cx="680"');
  });
  it("keeps unsupported out-of-support boundaries from expanding or breaking the plot", () => {
    const html = renderToStaticMarkup(createElement(Histogram, {
      buckets: bins, centralRange: { lower: 1000, upper: 3000 }, threshold: 5000,
      operator: "above", onBoundary: () => {},
    }));
    expect(html).toContain('cx="680"');
    expect(html).toContain('class="selection-band" x="680" y="30" width="0"');
    expect(boundaryProbability(bins, 5000, "above")).toBeNull();
  });
});
