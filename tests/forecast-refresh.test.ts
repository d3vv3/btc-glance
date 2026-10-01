import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { ForecastResult, TimelineResult } from "../src/lib/types";
import { convertQuotes, summarize } from "../src/lib/forecast";
import { market, now, quote } from "./fixtures";

const hooks = vi.hoisted(() => ({ states: [] as any[], refs: [] as any[], effects: [] as (() => void | (() => void))[], state: 0, ref: 0 }));
const reads = vi.hoisted(() => ({ public: vi.fn(), freshness: vi.fn() }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
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
import { Projection } from "../src/components/Projection";
import { WeatherApp } from "../src/components/WeatherApp";

const bins = convertQuotes(quote(), 3).buckets;
const forecast: ForecastResult = { market, status: "ready", diagnostics: [], freshUntil: new Date(now + 300000).toISOString(), forecast: { snapshotId: 1, topicId: market.topicId, targetAt: market.targetAt, capturedAt: new Date(now).toISOString(), source: "live", buckets: bins, summary: summarize(bins), transformationVersion: "quote-share-v1", originalYesSum: 100, normalizationFactor: 1, normalized: false, interpretation: "quote-share-not-calibrated", caveat: "" } };
const timeline = (target: ForecastResult): TimelineResult => ({ cadence: "hourly", asOf: new Date(now).toISOString(), collectedAt: new Date(now).toISOString(), source: "live", targets: [target] });
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const nodes = (tree: any): ReactElement<any>[] => !tree || typeof tree !== "object" ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];

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

  const mountWeather = async () => {
    render(() => WeatherApp()); effect(0); await settle();
    render(() => WeatherApp()); effect(1); await settle();
    return render(() => WeatherApp());
  };
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
    expect(status?.props.children).toContain(cached ? "Cached" : "Live");
    if (cached) expect(JSON.stringify(tree)).toContain("Offline");
  });
  it("retains an unsupported URL boundary with a warning and no numeric chance or handoff", async () => {
    vi.stubGlobal("location", { href: `https://weather.example.com/?market=${market.topicId}&boundary=1500`, search: `?market=${market.topicId}&boundary=1500` });
    const tree = await mountWeather();
    const elements = nodes(tree);
    expect(hooks.states[6]).toBe(1500);
    expect(elements.find(node => node.props.className === "probability")?.props.children[1].props.children).toBe("Unavailable");
    expect(elements.some(node => node.props["aria-label"] === "Watch this boundary")).toBe(false);
    expect(elements.some(node => node.props.role === "alert" && String(node.props.children).includes("not offered"))).toBe(true);
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
    expect(elements.some(node => node.props.role === "alert" && String(node.props.children).includes("not offered"))).toBe(true);
  });
  it("revalidates retained route context against the newly selected target's bins", async () => {
    vi.stubGlobal("location", { href: `https://weather.example.com/?market=${market.topicId}&boundary=2000`, search: `?market=${market.topicId}&boundary=2000` });
    const tree = await mountWeather();
    const next = { ...forecast, market: { ...market, topicId: 456 }, forecast: { ...forecast.forecast!, topicId: 456, buckets: bins.map(b => ({ ...b, lower: b.lower + 500, upper: b.upper + 500 })) } };
    reads.public.mockResolvedValue({ data: next, cachedAt: null });
    nodes(tree).find(node => node.type === "select" && node.props["aria-label"] === "Forecast time")!.props.onChange({ target: { value: "456" } });
    cleanups[1]();
    render(() => WeatherApp()); effect(1); await settle();
    const elements = nodes(render(() => WeatherApp()));
    expect(hooks.states[6]).toBe(2000);
    expect(elements.find(node => node.props.className === "probability")?.props.children[1].props.children).toBe("Unavailable");
    expect(elements.some(node => node.props["aria-label"] === "Watch this boundary")).toBe(false);
  });
});
