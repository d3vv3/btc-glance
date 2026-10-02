import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Watches, WatchSwitch } from "../src/components/Watches";
import { boundaryProbability } from "../src/components/WeatherApp";
import { convertQuotes, summarize } from "../src/lib/forecast";
import type { ForecastResult } from "../src/lib/types";
import { market, now, quote } from "./fixtures";
const formState = vi.hoisted(() => ({ index: 0, open: true }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useState: (initial: unknown) => [formState.index++ === 17 ? formState.open : initial, vi.fn()] }));

afterEach(() => { vi.useRealTimers(); formState.index = 0; formState.open = true; });
const buckets = convertQuotes(quote([10, 80, 10]), 3).buckets;
const result: ForecastResult = { market, status: "ready", diagnostics: [], freshUntil: new Date(now + 300000).toISOString(), forecast: { snapshotId: 1, topicId: market.topicId, capturedAt: new Date(now).toISOString(), source: "live", targetAt: market.targetAt, buckets, summary: summarize(buckets), transformationVersion: "quote-share-v2", originalYesSum: 100, normalizationFactor: 1, normalized: false, interpretation: "quote-share-not-calibrated", caveat: "" } };
const props = { result, threshold: buckets[1].lower, operator: "below" as const, offline: false, onSelect: vi.fn(), onOperatorChange: vi.fn(), onThresholdChange: vi.fn() };

it("keeps Above/Below and watch settings in the form without explanatory prose", () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const html = renderToStaticMarkup(createElement(Watches, props));
  const form = html.slice(html.indexOf("<form"), html.indexOf("</form>"));
  expect(form).toContain('aria-label="Watch direction"');
  expect(form).toContain('type="button" aria-pressed="true">Below');
  expect(form).toContain('aria-label="Watch boundary"');
  for (const boundary of new Set(buckets.flatMap(bucket => [bucket.lower, bucket.upper]))) {
    expect(form).toContain(`value="${boundary}"`);
  }
  expect(form).toContain(`value="${props.threshold}" selected=""`);
  expect(form).toContain('type="button" aria-pressed="false">Above');
  expect(form).not.toMatch(/<(details|summary|p)\b|Advanced|Alerts when|Select an offered price/);
  expect(form).toContain('type="number" min="0.1" max="100" step="0.1" required=""');
  expect(form).toContain("Change by (points)");
  expect(form).toContain("Minimum time between alerts");
  for (const seconds of [300, 900, 1800, 3600]) expect(form).toContain(`value="${seconds}"`);
  expect(form).toContain('value="3600" selected=""');
   expect(form).toContain('type="checkbox" role="switch" aria-label="Enable watch"');
   expect(form).toContain('checked=""');
   expect(form).not.toContain("Watch enabled");
   expect(html).not.toContain('class="primary icon-button watch-fab"');
  expect(form).toMatch(/<button class="primary" type="submit"/);
  expect(html).not.toMatch(/Send test|Disconnect|Permission:/);
  expect(form).not.toContain("This boundary is not offered");
  expect(boundaryProbability(buckets, props.threshold, "below")).toBeCloseTo(.1);
  expect(boundaryProbability(buckets, props.threshold, "above")).toBeCloseTo(.9);
});

it("initially renders the saved list before New watch with no selection form", () => {
  formState.open = false;
  const html = renderToStaticMarkup(createElement(Watches, props));
  expect(html).not.toContain("<form");
   expect(html.indexOf('class="watch-list watch-list-fab"')).toBeLessThan(html.indexOf("New watch"));
   expect(html).toContain('aria-label="New watch" title="New watch"');
   expect(html).not.toContain('>New watch<');
   expect(html).toContain('lucide-plus');
  expect(html).toContain('id="watch-title">Watches');
  expect(html).not.toMatch(/Watch boundary|Market cadence|Send test|Disconnect/);
});

it.each([true, false])("renders a native named switch with checked=%s and pending disabled state", checked => {
  const html = renderToStaticMarkup(createElement(WatchSwitch, { checked, disabled: true, label: "Enable watch below $86,000", onChange: vi.fn() }));
  expect(html).toContain('type="checkbox" role="switch" aria-label="Enable watch below $86,000" disabled=""');
  expect(html.includes('checked=""')).toBe(checked);
  expect(html).not.toMatch(/>Enabled<|>Watch enabled</);
});

it.each([
  { name: "unsupported boundary", overrides: { threshold: NaN } },
  { name: "unoffered boundary", overrides: { threshold: buckets[1].lower + 1 } },
  { name: "offline", overrides: { offline: true } },
  { name: "historical", overrides: { historical: true } },
  { name: "unavailable forecast", overrides: { result: null } },
  { name: "expired forecast", overrides: { result: { ...result, freshUntil: new Date(now - 1).toISOString() } } },
  { name: "closed target", overrides: { result: { ...result, forecast: { ...result.forecast!, targetAt: new Date(now).toISOString() } } } },
  { name: "demo forecast", overrides: { result: { ...result, forecast: { ...result.forecast!, source: "demo" as const } } } },
])("disables creation for $name without warning prose", ({ overrides }) => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const html = renderToStaticMarkup(createElement(Watches, { ...props, ...overrides }));
  const form = html.slice(html.indexOf("<form"), html.indexOf("</form>"));
  expect(form).not.toMatch(/<(details|summary|p)\b|Select an offered price|This boundary is not offered/);
  expect(form).toMatch(/disabled="" type="submit"/);
});
