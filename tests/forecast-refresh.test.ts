import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { ForecastResult, TimelineResult } from "../src/lib/types";
import { convertQuotes, summarize } from "../src/lib/forecast";
import { market, now, quote } from "./fixtures";

const hooks = vi.hoisted(() => ({ states: [] as any[], refs: [] as any[], effects: [] as (() => void | (() => void))[], state: 0, ref: 0 }));
const reads = vi.hoisted(() => ({ public: vi.fn(), freshness: vi.fn() }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useId: () => "forecast-refresh-plot",
  useState: (initial: unknown) => {
    const i = hooks.state++;
    if (!(i in hooks.states)) hooks.states[i] = initial;
    return [hooks.states[i], (value: any) => { hooks.states[i] = typeof value === "function" ? value(hooks.states[i]) : value; }];
  },
  useRef: (initial: unknown) => { const i = hooks.ref++; return hooks.refs[i] ??= { current: initial }; },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); },
}));
vi.mock("../src/client/api", () => ({ publicRead: reads.public, api: { forecasts: { freshness: { query: reads.freshness } } } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
import { Projection } from "../src/components/Projection";
import { WeatherApp } from "../src/components/WeatherApp";
import { Navigation } from "../src/components/Navigation";
import { Watches } from "../src/components/Watches";

const bins = convertQuotes(quote(), 3).buckets;
const forecast: ForecastResult = { market, status: "ready", diagnostics: [], freshUntil: new Date(now + 300000).toISOString(), forecast: { snapshotId: 1, topicId: market.topicId, targetAt: market.targetAt, capturedAt: new Date(now).toISOString(), source: "live", buckets: bins, summary: summarize(bins), transformationVersion: "quote-share-v1", originalYesSum: 100, normalizationFactor: 1, normalized: false, interpretation: "quote-share-not-calibrated", caveat: "" } };
const timeline = (target: ForecastResult): TimelineResult => ({ cadence: "hourly", asOf: new Date(now).toISOString(), collectedAt: new Date(now).toISOString(), source: "live", targets: [target] });
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const nodes = (tree: any): ReactElement<any>[] => !tree || typeof tree !== "object" ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children), ...nodes(tree.props?.cadenceControls), ...nodes(tree.props?.forecastLabel)];

describe("forecast refresh and boundary safety", () => {
  let browser: EventTarget;
  let cleanups: (() => void)[];
  const render = <T,>(component: () => T): T => { hooks.state = 0; hooks.ref = 0; hooks.effects = []; return component(); };
  const effect = (index: number) => { const cleanup = hooks.effects[index](); if (typeof cleanup === "function") cleanups.push(cleanup); };
  const settle = async () => { await vi.advanceTimersByTimeAsync(0); };
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(now); vi.resetAllMocks();
    hooks.states = []; hooks.refs = []; cleanups = [];
    browser = new EventTarget();
    vi.stubGlobal("window", Object.assign(browser, { setInterval }));
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("location", { href: `https://weather.example.com/?market=${market.topicId}`, search: `?market=${market.topicId}` });
    vi.stubGlobal("history", { replaceState: vi.fn() });
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => callback());
    reads.public.mockImplementation((path: string) => path === "/api/markets" ? Promise.resolve({ data: { markets: [market], source: "live", collectedAt: null }, cachedAt: null }) : Promise.resolve({ data: forecast, cachedAt: null }));
    reads.freshness.mockImplementation(() => new Promise(() => {}));
  });
  afterEach(() => { cleanups.forEach(fn => fn()); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it.each(["ready", "error"])("does not let older %s overwrite a newer invalid projection", async older => {
    const first = deferred<any>(), second = deferred<any>();
    reads.public.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const component = () => Projection({ cadence: "hourly", now, offline: false, topic: null, onSelect: () => {} });
    render(component); effect(1);
    const signal = reads.public.mock.calls[0][1] as AbortSignal;
    browser.dispatchEvent(new Event("focus"));
    expect(signal.aborted).toBe(true);
    second.resolve({ data: timeline({ ...forecast, status: "invalid", forecast: null }), cachedAt: null }); await settle();
    if (older === "ready") first.resolve({ data: timeline(forecast), cachedAt: null }); else first.reject(new Error("Old failure"));
    await settle(); render(component);
    expect(hooks.states[0].targets[0].status).toBe("invalid");
    expect(hooks.states[2]).toBe("");
    cleanups[0]();
    expect((reads.public.mock.calls[1][1] as AbortSignal).aborted).toBe(true);
  });

  it("retries unavailable projection data through the live fetch and restores the price plot", async () => {
    reads.public.mockResolvedValueOnce({ data: timeline({ ...forecast, status: "unavailable", forecast: null }), cachedAt: null });
    const component = () => Projection({ cadence: "hourly", now, offline: false, topic: null, onSelect: () => {} });
    render(component); effect(1); await settle();
    const unavailable = nodes(render(component));
    expect(unavailable.some(node => node.props.className === "projection-price-axis")).toBe(false);
    reads.public.mockResolvedValueOnce({ data: timeline(forecast), cachedAt: null });
    unavailable.find(node => node.type === "button" && nodes(node).some(child => child.props.children === "Retry" || Array.isArray(child.props.children) && child.props.children.includes("Retry")))!.props.onClick();
    await settle();
    expect(reads.public).toHaveBeenCalledTimes(2);
    expect(nodes(render(component)).some(node => node.props.className === "projection-price-axis")).toBe(true);
  });

  const mountWeather = async () => {
    render(() => WeatherApp()); effect(0); await settle();
    render(() => WeatherApp()); effect(1); await settle();
    return render(() => WeatherApp());
  };
  it("keeps historical evidence and status without a latest-outlook action or banner", async () => {
    vi.stubGlobal("location", { href: "https://weather.example.com/?snapshotId=1", search: "?snapshotId=1" });
    const elements = nodes(await mountWeather());
    expect(reads.public).toHaveBeenCalledWith("/api/forecasts/snapshot?snapshotId=1");
    expect(elements.some(node => node.props["aria-label"] === "Historical")).toBe(true);
    expect(elements.some(node => node.type === "time" && node.props.dateTime === forecast.forecast!.targetAt)).toBe(true);
    expect(elements.some(node => node.props.className === "historical-notice" || node.props.className === "latest-outlook")).toBe(false);
     expect(JSON.stringify(elements)).not.toMatch(/Return to latest outlook|Latest outlook/i);
     expect(elements.some(node => node.props["aria-label"] === "Forecast time")).toBe(false);
  });
  it("retains the normal Outlook navigation on a historical route", () => {
    vi.stubGlobal("location", { search: "?snapshotId=1" });
    render(() => Navigation()); effect(0);
    const elements = nodes(render(() => Navigation()));
    const outlook = elements.find(node => node.type === "a" && nodes(node).some(child => child.type === "span" && child.props.children === "Outlook"));
    expect(outlook?.props.href).toBe("/?snapshotId=1");
    expect(outlook?.props["aria-current"]).toBe("page");
  });
  it("keeps capture time accessible without visible technical prose or an inspector", async () => {
    const elements = nodes(await mountWeather());
    expect(elements.some(node => node.type === "details" || node.type === "summary")).toBe(false);
    expect(elements.some(node => node.props.className === "source-footnote")).toBe(false);
    expect(elements.some(node => node.type === "time" && node.props.dateTime === forecast.forecast!.capturedAt)).toBe(true);
    expect(elements.some(node => node.props.className === "sr-only" && nodes(node).some(child => child.type === "time" && child.props.dateTime === forecast.forecast!.capturedAt))).toBe(true);
  });
  it("shows an unavailable state without diagnostic or warning prose", async () => {
    reads.public.mockImplementation((path: string) => Promise.resolve({ data: path === "/api/markets" ? { markets: [market], source: "live", collectedAt: null } : { ...forecast, status: "invalid", forecast: null, diagnostics: Array.from({ length: 500 }, (_, i) => ({ code: "coverage", message: `Raw outcome ${i}` })), provenance: { snapshotId: 1, capturedAt: new Date(now).toISOString(), raw: {} } }, cachedAt: null }));
    const elements = nodes(await mountWeather());
    expect(elements.some(node => node.props.className === "small warning")).toBe(false);
    expect(elements.some(node => node.type === "h1" && node.props.role === "status" && node.props.children === "Unavailable")).toBe(true);
    expect(elements.some(node => node.props.className === "probability")).toBe(false);
    expect(JSON.stringify(elements)).not.toContain("Raw outcome");
    expect(elements.some(node => node.type === "details" || node.type === "summary")).toBe(false);
  });
  it.each([false, true])("renders public evidence without awaiting hanging tRPC (cached=%s)", async cached => {
    if (cached) {
      vi.stubGlobal("navigator", { onLine: false });
      reads.freshness.mockRejectedValue(new Error("Offline"));
      reads.public.mockImplementation((path: string) => Promise.resolve({ data: path === "/api/markets" ? { markets: [market], source: "live", collectedAt: null } : forecast, cachedAt: new Date(now).toISOString() }));
    }
    const tree = await mountWeather();
    expect(hooks.states[1]).toEqual(forecast);
    expect(hooks.states[12]).toBe(false);
    expect(reads.freshness).not.toHaveBeenCalled();
    const status = nodes(tree).find(node => typeof node.props.className === "string" && node.props.className.startsWith("status "));
    expect(status?.props["aria-label"]).toBe(cached ? "Offline" : "Live");
    expect(nodes(status).some(node => node.props.className === "sr-only" && node.props.children === (cached ? "Offline" : "Live"))).toBe(true);
    if (cached) expect(JSON.stringify(tree)).toContain("Offline");
  });
  it("retains an unsupported URL boundary without prose, numeric chance or handoff", async () => {
    vi.stubGlobal("location", { href: `https://weather.example.com/?market=${market.topicId}&boundary=1500`, search: `?market=${market.topicId}&boundary=1500` });
    const tree = await mountWeather();
    const elements = nodes(tree);
    expect(hooks.states[6]).toBe(1500);
    expect(elements.find(node => node.props.className === "probability")?.props.children[1].props.children).toBe("Unavailable");
    expect(elements.some(node => node.props["aria-label"] === "Watch this boundary")).toBe(false);
    expect(elements.some(node => node.props.role === "alert")).toBe(false);
    elements.find(node => node.type === "select" && node.props["aria-label"] === "Chance price")!.props.onChange({ target: { value: "2000" } });
    const updated = nodes(render(() => WeatherApp()));
    expect(updated.find(node => node.props.className === "probability")?.props.children[1].props.children).toBe("20.0%");
    expect(updated.some(node => node.props["aria-label"] === "Watch this boundary")).toBe(true);
  });
  it("canonicalizes URL rounding noise to the actual offered boundary", async () => {
    vi.stubGlobal("location", { href: `https://weather.example.com/?market=${market.topicId}&boundary=1000.0000000001`, search: `?market=${market.topicId}&boundary=1000.0000000001` });
    await mountWeather();
    expect(hooks.states[6]).toBe(1000);
    effect(2);
    expect(vi.mocked(history.replaceState).mock.calls.at(-1)?.[2]?.toString()).toContain("boundary=1000&operator=above");
  });
  it.each(["NaN", "Infinity", "", "not-a-price"])("rejects nonfinite or malformed URL boundary %s", async raw => {
    vi.stubGlobal("location", { href: `https://weather.example.com/?market=${market.topicId}&boundary=${raw}`, search: `?market=${market.topicId}&boundary=${raw}` });
    const elements = nodes(await mountWeather());
    expect(elements.find(node => node.props.className === "probability")?.props.children[1].props.children).toBe("Unavailable");
    expect(elements.some(node => node.props["aria-label"] === "Watch this boundary")).toBe(false);
    expect(elements.some(node => node.props.role === "alert")).toBe(false);
  });
  it("chooses an offered modal boundary after a user selects another target", async () => {
    vi.stubGlobal("location", { href: `https://weather.example.com/?market=${market.topicId}&boundary=2000`, search: `?market=${market.topicId}&boundary=2000` });
    const tree = await mountWeather();
    const next = { ...forecast, market: { ...market, topicId: 456 }, forecast: { ...forecast.forecast!, topicId: 456, buckets: bins.map(b => ({ ...b, lower: b.lower + 500, upper: b.upper + 500 })) } };
    reads.public.mockResolvedValue({ data: next, cachedAt: null });
    expect(nodes(tree).some(node => node.props["aria-label"] === "Forecast time")).toBe(false);
    nodes(tree).find(node => node.type === Projection)!.props.onSelect(456);
    cleanups[1]();
    render(() => WeatherApp()); effect(1); await settle();
    const elements = nodes(render(() => WeatherApp()));
    expect(hooks.states[6]).toBe(2500);
    expect(elements.find(node => node.props.className === "probability")?.props.children[1].props.children).toBe("20.0%");
    expect(elements.some(node => node.props["aria-label"] === "Watch this boundary")).toBe(true);
  });
  it("resets Daily to an exact supported boundary and preserves Below without interpolating", async () => {
    const daily = { ...market, topicId: 456, cadence: "daily" as const };
    reads.public.mockImplementation((path: string) => Promise.resolve({ data: path === "/api/markets" ? { markets: [market, daily], source: "live", collectedAt: null } : path.includes("456") ? { ...forecast, market: daily, forecast: { ...forecast.forecast!, topicId: 456, buckets: bins.map(b => ({ ...b, lower: b.lower + 85000, upper: b.upper + 85000 })) } } : forecast, cachedAt: null }));
    vi.stubGlobal("location", { href: `https://weather.example.com/watches?market=${market.topicId}&boundary=1000&operator=below`, search: `?market=${market.topicId}&boundary=1000&operator=below` });
    const mount = async () => { render(() => WeatherApp({ mode: "watches" })); effect(0); await settle(); render(() => WeatherApp({ mode: "watches" })); effect(1); await settle(); return render(() => WeatherApp({ mode: "watches" })); };
    const tree = await mount();
    expect(tree.type).toBe(Watches);
    expect(nodes(tree).some(node => node.props["aria-label"] === "Forecast time")).toBe(false);
    const controls = nodes(tree.props.selectionControls(false));
    expect(controls.filter(node => node.type === "select" && node.props["aria-label"] === "Forecast time")).toHaveLength(1);
    expect(controls.find(node => node.props["aria-label"] === "Forecast time")?.props.disabled).toBe(false);
    expect(nodes(tree.props.selectionControls(true)).find(node => node.props["aria-label"] === "Forecast time")?.props.disabled).toBe(true);
    controls.find(node => node.type === "button" && node.props.children === "Daily")!.props.onClick();
    cleanups[1](); render(() => WeatherApp({ mode: "watches" })); effect(1); await settle();
    const updated = render(() => WeatherApp({ mode: "watches" }));
    expect(updated.props.threshold).toBe(87000);
    expect(updated.props.operator).toBe("below");
    expect(updated.props.result.status).toBe("ready");
    effect(2);
    expect(vi.mocked(history.replaceState).mock.calls.at(-1)?.[2]?.toString()).toContain("boundary=87000&operator=below");
  });
   it("renders the watch time picker only in the expanded New watch form", async () => {
     await mountWeather();
     const props = render(() => WeatherApp({ mode: "watches" })).props;
     hooks.states = []; hooks.refs = [];
     const collapsed = nodes(render(() => Watches(props)));
     expect(collapsed.some(node => node.props["aria-label"] === "Forecast time")).toBe(false);
     collapsed.find(node => node.type === "button" && node.props["aria-label"] === "New watch")!.props.onClick();
     const expanded = nodes(render(() => Watches(props)));
     expect(expanded.filter(node => node.props["aria-label"] === "Forecast time")).toHaveLength(1);
     for (const label of ["Market cadence", "Watch direction", "Watch boundary"]) {
       expect(expanded.some(node => node.props["aria-label"] === label)).toBe(true);
     }
     expanded.find(node => node.type === "button" && node.props.children === "Cancel")!.props.onClick();
     expect(nodes(render(() => Watches(props))).some(node => node.props["aria-label"] === "Forecast time")).toBe(false);
   });
   it("preserves an unsupported saved watch condition rather than snapping it to the new grid", async () => {
    const tree = await mountWeather();
    // The Watches parent restores the exact saved condition, even if that grid has changed.
    const watchTree = render(() => WeatherApp({ mode: "watches" }));
    watchTree.props.onSelect(456, 86400, "below");
    reads.public.mockResolvedValue({ data: { ...forecast, market: { ...market, topicId: 456 }, forecast: { ...forecast.forecast!, topicId: 456, buckets: bins.map(b => ({ ...b, lower: b.lower + 85000, upper: b.upper + 85000 })) } }, cachedAt: null });
    cleanups[1](); render(() => WeatherApp({ mode: "watches" })); effect(1); await settle();
    const updated = render(() => WeatherApp({ mode: "watches" }));
    expect(updated.props.threshold).toBe(86400);
    expect(updated.props.operator).toBe("below");
    expect(tree).toBeDefined();
  });
});
