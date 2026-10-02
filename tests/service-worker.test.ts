import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { generateServiceWorker, readWorkerVersion } from "../scripts/build-service-worker.mjs";
import ts from "typescript";

const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const origin = "https://weather.example";

function makeCache(html: string, contentType: string, failAsset: string) {
  const entries = new Map<string, Response>();
  const key = (request: string | Request) => typeof request === "string" ? request : request.url;
  return {
    entries,
    addAll: vi.fn(async (paths: string[]) => { for (const path of paths.filter(path => ["/", "/watches", "/history"].includes(path))) entries.set(path, new Response(html, { headers: { "Content-Type": contentType } })); }),
    add: vi.fn(async (path: string) => { if (path === failAsset) throw new Error("Asset failed"); }),
    keys: vi.fn(async () => [...entries.keys()]),
    match: vi.fn(async (request: string | Request) => entries.get(key(request))?.clone()),
    put: vi.fn(async (request: string | Request, response: Response) => { entries.set(key(request), response); }),
  };
}

function worker({ html = '<script src="/_next/static/app.js"></script><link href="/_next/static/app.css" rel="stylesheet">', failAsset = "", contentType = "text/html", workerSource = source, store = new Map<string, ReturnType<typeof makeCache>>() } = {}) {
  const handlers: Record<string, (event: any) => void> = {};
  const open = (name: string) => {
    if (!store.has(name)) store.set(name, makeCache(html, contentType, failAsset));
    return store.get(name)!;
  };
  const version = /const VERSION = "([^"]+)"/.exec(workerSource)![1];
  const cache = open(`${version}-shell`);
  const dataCache = open("bitcoin-weather-public-v1");
  const deleteCache = vi.fn(async (name: string) => store.delete(name));
  const clients = { matchAll: vi.fn(async () => [] as any[]), openWindow: vi.fn(async () => {}), claim: vi.fn(async () => {}) };
  const skipWaiting = vi.fn();
  const registration = { showNotification: vi.fn(async () => {}) };
  const fetch = vi.fn(async () => new Response('{"forecast":null}', { headers: { "Content-Type": "application/json" } }));
  runInNewContext(workerSource, {
    self: { location: { origin }, addEventListener: (name: string, handler: (event: any) => void) => { handlers[name] = handler; }, clients, registration, skipWaiting },
    caches: { open: async (name: string) => open(name), keys: async () => [...store.keys()], delete: deleteCache }, fetch, URL, Response, Headers, AbortController, setTimeout, clearTimeout,
  });
  const dispatch = (name: string, event: Record<string, unknown> = {}) => {
    let pending: Promise<unknown> | undefined;
    handlers[name]({ ...event, waitUntil: (promise: Promise<unknown>) => { pending = promise; }, respondWith: (promise: Promise<unknown>) => { pending = promise; } });
    return pending;
  };
  return { cache, dataCache, store, open, version, deleteCache, skipWaiting, clients, registration, fetch, dispatch };
}

describe("service worker shell installation", () => {
  it("caches bounded public pastCount queries but never private or malformed variants", async () => {
    const sw = worker();
    for (const search of ["?cadence=daily&pastCount=0", "?cadence=hourly&pastCount=7&limit=32"]) {
      const response = await sw.dispatch("fetch", { request: new Request(`${origin}/api/forecasts/timeline${search}`) });
      expect(response).toBeInstanceOf(Response);
      expect(sw.dataCache.entries.has(`${origin}/api/forecasts/timeline${search}`)).toBe(true);
    }
    for (const search of ["?pastCount=8", "?pastCount=03", "?pastCount=3&owner=secret", "?pastCount=3&pastCount=7"]) {
      expect(sw.dispatch("fetch", { request: new Request(`${origin}/api/forecasts/timeline${search}`) })).toBeUndefined();
      expect(sw.dataCache.entries.has(`${origin}/api/forecasts/timeline${search}`)).toBe(false);
    }
  });
  it("requires the discovered JS and CSS before installation succeeds", async () => {
    const sw = worker();
    await sw.dispatch("install");
    expect(sw.cache.add).toHaveBeenCalledWith("/_next/static/app.js");
    expect(sw.cache.add).toHaveBeenCalledWith("/_next/static/app.css");
    expect(sw.skipWaiting).not.toHaveBeenCalled();
  });
  it.each(["/_next/static/app.js", "/_next/static/app.css"])("rejects installation when %s fails", async failAsset => {
    await expect(worker({ failAsset }).dispatch("install")).rejects.toThrow("Asset failed");
  });
  it("rejects missing scripts and non-HTML shells", async () => {
    await expect(worker({ html: "<html>Unavailable</html>" }).dispatch("install")).rejects.toThrow("Required Next");
    await expect(worker({ contentType: "text/plain" }).dispatch("install")).rejects.toThrow("Required HTML");
  });
  it("propagates initial required asset failures", async () => {
    const sw = worker();
    sw.cache.addAll.mockRejectedValueOnce(new Error("Shell failed"));
    await expect(sw.dispatch("install")).rejects.toThrow("Shell failed");
  });
  it("requires every route's HTML and route-specific scripts", async () => {
    const sw = worker();
    sw.cache.addAll.mockImplementationOnce(async () => {
      for (const path of ["/", "/watches", "/history"]) sw.cache.entries.set(path, new Response(`<script src="/_next/static/${path === "/" ? "outlook" : path.slice(1)}.js"></script><link href="/_next/static/shared.css">`, { headers: { "Content-Type": "text/html" } }));
    });
    await sw.dispatch("install");
    for (const page of ["outlook", "watches", "history"]) expect(sw.cache.add).toHaveBeenCalledWith(`/_next/static/${page}.js`);
    sw.cache.entries.delete("/history");
    sw.cache.addAll.mockImplementationOnce(async () => {});
    await expect(sw.dispatch("install")).rejects.toThrow("/history");
  });
});

describe("notification deep links", () => {
  it("defaults to BTC glance while retaining the body, icon and notification tag identity", async () => {
    const sw = worker();
    await sw.dispatch("push", { data: { json: () => ({ body: "Market quote share: 20.0% to 30.0%." }) } });
    expect(sw.registration.showNotification).toHaveBeenCalledWith("BTC glance", expect.objectContaining({
      body: "Market quote share: 20.0% to 30.0%.",
      icon: "/icons/icon-192.png?v=sun-orb-3", tag: "bitcoin-weather",
    }));
  });
  it("preserves an explicit notification payload title and body", async () => {
    const sw = worker();
    await sw.dispatch("push", { data: { json: () => ({ title: "Market update", body: "Unchanged payload", tag: "watch-123-17" }) } });
    expect(sw.registration.showNotification).toHaveBeenCalledWith("Market update", expect.objectContaining({ body: "Unchanged payload", tag: "watch-123-17" }));
  });
  it("does not duplicate a window when focus fails after navigation", async () => {
    const sw = worker();
    const focus = vi.fn(async () => { throw new Error("Focus refused"); });
    sw.clients.matchAll.mockResolvedValueOnce([{ url: `${origin}/`, navigate: vi.fn(async () => ({ focus })) }]);
    await expect(sw.dispatch("notificationclick", { notification: { data: { url: "/?market=42" }, close: vi.fn() } })).resolves.toBeUndefined();
    expect(focus).toHaveBeenCalledOnce();
    expect(sw.clients.openWindow).not.toHaveBeenCalled();
  });
  it.each(["reject", "null"])("opens a fallback only when navigation fails (%s)", async failure => {
    const sw = worker();
    const navigate = vi.fn(async () => { if (failure === "reject") throw new Error("Window closed"); return null; });
    sw.clients.matchAll.mockResolvedValueOnce([{ url: `${origin}/`, navigate }]);
    await sw.dispatch("notificationclick", { notification: { data: { url: "/?market=42" }, close: vi.fn() } });
    expect(sw.clients.openWindow).toHaveBeenCalledExactlyOnceWith(`${origin}/?market=42`);
  });
  const watch = "12345678-1234-1234-1234-123456789abc";
  it.each([
    { url: `/?market=42&watch=${watch}&snapshotId=17&view=evidence` },
    { url: "/?view=evidence", topicId: 42, watchId: watch, snapshotId: 17 },
  ])("preserves snapshot, market, watch and other supplied query through push and click", async data => {
    const sw = worker();
    await sw.dispatch("push", { data: { json: () => data } });
    const options = sw.registration.showNotification.mock.calls[0] as unknown as [string, { data: { url: string } }];
    await sw.dispatch("notificationclick", { notification: { data: options[1].data, close: vi.fn() } });
    const url = new URL((sw.clients.openWindow.mock.calls[0] as unknown as [string])[0]);
    expect(url.origin).toBe(origin);
    expect(url.searchParams.get("market")).toBe("42");
    expect(url.searchParams.get("watch")).toBe(watch);
    expect(url.searchParams.get("snapshotId")).toBe("17");
    expect(url.searchParams.get("view")).toBe("evidence");
  });
  it("rejects external notification destinations", async () => {
    const sw = worker();
    await sw.dispatch("notificationclick", { notification: { data: { url: "https://evil.example/?snapshotId=17" }, close: vi.fn() } });
    expect(sw.clients.openWindow).toHaveBeenCalledWith(`${origin}/`);
  });
  it.each(["above", "below"])("preserves the event-time %s condition through push and click", async operator => {
    const sw = worker();
    await sw.dispatch("push", { data: { json: () => ({ topicId: 42, snapshotId: 17, tag: `watch-${watch}-17`, event: { operator, threshold: 1000.5, previousProbability: 0.2, probability: 0.4 }, url: "/?topicId=42&snapshotId=17&operator=below&boundary=999" }) } });
    const [, options] = sw.registration.showNotification.mock.calls[0] as unknown as [string, { data: { url: string } }];
    await sw.dispatch("notificationclick", { notification: { data: options.data, close: vi.fn() } });
    const url = new URL((sw.clients.openWindow.mock.calls[0] as unknown as [string])[0]);
    expect(Object.fromEntries(url.searchParams)).toEqual({ market: "42", watch, snapshotId: "17", operator, boundary: "1000.5" });
  });
  it("keeps a validated condition already in the URL, including zero", async () => {
    const sw = worker();
    await sw.dispatch("notificationclick", { notification: { data: { url: "/?operator=below&boundary=0" }, close: vi.fn() } });
    expect(sw.clients.openWindow).toHaveBeenCalledWith(`${origin}/?operator=below&boundary=0`);
  });
  it.each([
    null, [], { operator: "sideways", threshold: 1000 }, { operator: "above", threshold: -1 },
    { operator: "above", threshold: Infinity }, { operator: "above", threshold: NaN },
    { operator: "above", threshold: "1000" }, { operator: "above", threshold: null },
    { operator: "above", threshold: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects invalid event schemas without falling back to injected URL conditions: %j", async event => {
    const sw = worker();
    await sw.dispatch("push", { data: { json: () => ({ event, url: "/?market=42&operator=above&boundary=1000" }) } });
    const [, options] = sw.registration.showNotification.mock.calls[0] as unknown as [string, { data: { url: string } }];
    expect(options.data.url).toBe(`${origin}/?market=42`);
  });
  it.each([
    "operator=sideways&boundary=1000", "operator=above&boundary=-1", "operator=above&boundary=Infinity",
    "operator=above&boundary=", "operator=above&boundary=0x10", "operator=above&boundary=1e309",
    "operator=above&boundary=9007199254740992", "operator=above&boundary=1&boundary=2",
    "operator=above&operator=below&boundary=1", "market=garbage&watch=../../private&snapshotId=-1",
    "market=9007199254740992&snapshotId=9007199254740992", "market=1&market=2", "view=private&owner=secret&next=https://evil.example",
  ])("removes unsafe or unsupported notification query values: %s", async query => {
    const sw = worker();
    await sw.dispatch("notificationclick", { notification: { data: { url: `/?${query}#injected` }, close: vi.fn() } });
    expect(sw.clients.openWindow).toHaveBeenCalledWith(`${origin}/`);
  });
  it("navigates an existing window to the full evidence URL", async () => {
    const sw = worker();
    const focus = vi.fn();
    const navigate = vi.fn(async () => ({ focus }));
    sw.clients.matchAll.mockResolvedValueOnce([{ url: `${origin}/`, navigate }]);
    const url = `${origin}/?market=42&watch=${watch}&snapshotId=17`;
    await sw.dispatch("notificationclick", { notification: { data: { url }, close: vi.fn() } });
    expect(navigate).toHaveBeenCalledWith(url);
    expect(focus).toHaveBeenCalled();
    expect(sw.clients.openWindow).not.toHaveBeenCalled();
  });
});

describe("public snapshot cache boundary", () => {
  const older = "2026-10-01T10:00:00.000Z";
  const newer = "2026-10-01T11:00:00.000Z";
  const forecast = (capturedAt: string, invalid = false) => ({ forecast: invalid ? null : { capturedAt }, status: invalid ? "invalid" : "ready", provenance: { capturedAt } });
  const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
  const request = (url: string) => ({ request: { method: "GET", url } });
  const offline = async (sw: ReturnType<typeof worker>, url: string) => {
    sw.fetch.mockRejectedValueOnce(new Error("Offline"));
    return await sw.dispatch("fetch", request(url)) as Response;
  };
  it.each([false, true])("does not let a delayed older forecast overwrite newer evidence (invalid latest: %s)", async invalid => {
    const sw = worker(); const url = `${origin}/api/forecasts?topicId=42`;
    let resolveOlder!: (response: Response) => void;
    sw.fetch.mockImplementationOnce(() => new Promise(resolve => { resolveOlder = resolve; }));
    sw.fetch.mockResolvedValueOnce(json(forecast(newer, invalid)));
    const first = sw.dispatch("fetch", request(url));
    await sw.dispatch("fetch", request(url));
    resolveOlder(json(forecast(older)));
    await first;
    const cached = await offline(sw, url);
    expect(await cached.json()).toEqual(forecast(newer, invalid));
    expect(cached.headers.get("X-BW-Offline-Cached-At")).toBe(newer);
    expect(cached.headers.get("X-BW-Stored-At")).not.toBe(newer);
    expect(sw.dataCache.put).toHaveBeenCalledTimes(1);
  });
  it.each([
    { collectedAt: newer, asOf: newer },
    { collectedAt: older, asOf: newer },
  ])("keeps a newer invalid timeline over an older valid response: %j", async latest => {
    const sw = worker(); const url = `${origin}/api/forecasts/timeline`;
    const data = { ...latest, targets: [forecast(latest.collectedAt, true)] };
    let resolveOlder!: (response: Response) => void;
    sw.fetch.mockImplementationOnce(() => new Promise(resolve => { resolveOlder = resolve; }));
    const first = sw.dispatch("fetch", request(url));
    sw.fetch.mockResolvedValueOnce(json(data));
    await sw.dispatch("fetch", request(url));
    resolveOlder(json({ collectedAt: older, asOf: older, targets: [forecast(older)] }));
    await first;
    const cached = await offline(sw, url);
    expect(await cached.json()).toEqual(data);
    expect(cached.headers.get("X-BW-Offline-Cached-At")).toBe(latest.collectedAt);
  });
  it("serializes comparison and put while another cache write is pending", async () => {
    const sw = worker(); const url = `${origin}/api/forecasts?topicId=42`;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    sw.dataCache.put.mockImplementationOnce(async (key, response) => { await blocked; sw.dataCache.entries.set(key as string, response); });
    sw.fetch.mockResolvedValueOnce(json(forecast(older))).mockResolvedValueOnce(json(forecast(newer, true)));
    const first = sw.dispatch("fetch", request(url));
    await vi.waitFor(() => expect(sw.dataCache.put).toHaveBeenCalledTimes(1));
    const second = sw.dispatch("fetch", request(url));
    await vi.waitFor(() => expect(sw.fetch).toHaveBeenCalledTimes(2));
    expect(sw.dataCache.match).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(await (await offline(sw, url)).json()).toEqual(forecast(newer, true));
  });
  it("allows subsequent cache updates after a failed put", async () => {
    const sw = worker(); const url = `${origin}/api/forecasts?topicId=42`;
    sw.dataCache.put.mockRejectedValueOnce(new Error("Cache write failed"));
    sw.fetch.mockResolvedValueOnce(json(forecast(older))).mockResolvedValueOnce(json(forecast(newer)));
    await sw.dispatch("fetch", request(url));
    await sw.dispatch("fetch", request(url));
    expect(await (await offline(sw, url)).json()).toEqual(forecast(newer));
  });
  it("never treats a missing or malformed data timestamp as a new capture", async () => {
    const sw = worker(); const url = `${origin}/api/forecasts?topicId=42`;
    sw.fetch.mockResolvedValueOnce(json(forecast(newer)));
    await sw.dispatch("fetch", request(url));
    for (const data of [{ forecast: null }, forecast("not-a-date")]) {
      sw.fetch.mockResolvedValueOnce(json(data));
      await sw.dispatch("fetch", request(url));
    }
    expect(await (await offline(sw, url)).json()).toEqual(forecast(newer));
    const empty = worker();
    await empty.dispatch("fetch", request(url));
    const cached = await offline(empty, url);
    expect(cached.headers.get("X-BW-Offline-Cached-At")).toBe("unknown");
    expect(cached.headers.get("X-BW-Stored-At")).toBeTruthy();
  });
  it.each(["/api/forecasts/timeline", "/api/forecasts/timeline?cadence=hourly&limit=32", "/api/forecasts/timeline?limit=1&cadence=daily"])("caches only supported public timeline queries: %s", async path => {
    const sw = worker(); const url = origin + path;
    await sw.dispatch("fetch", { request: { method: "GET", url } });
    expect(sw.dataCache.put).toHaveBeenCalledWith(url, expect.any(Response));
    sw.fetch.mockRejectedValueOnce(new Error("Offline"));
    const response = await sw.dispatch("fetch", { request: { method: "GET", url } }) as Response;
    expect(response.headers.get("X-BW-Offline-Cached-At")).toBeTruthy();
  });
  it.each(["?owner=private", "?cadence=weekly", "?limit=0", "?limit=33", "?limit=1.5", "?limit=01", "?cadence=hourly&cadence=daily", "?limit=1&limit=2"])("does not cache unsupported timeline parameters %s", search => {
    const sw = worker();
    expect(sw.dispatch("fetch", { request: { method: "GET", url: origin + "/api/forecasts/timeline" + search } })).toBeUndefined();
  });
  it.each(["/", "/watches", "/history"])("reopens the exact public route offline: %s", async path => {
    const sw = worker(); await sw.dispatch("install"); sw.fetch.mockRejectedValue(new Error("Offline"));
    const response = await sw.dispatch("fetch", { request: { method: "GET", mode: "navigate", url: `${origin}${path}?market=42&boundary=1000&operator=below` } }) as Response;
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(await response.text()).toContain("app.js");
  });
  it("caches the exact public snapshot URL and serves it offline with provenance timestamp", async () => {
    const sw = worker();
    const url = `${origin}/api/forecasts/snapshot?snapshotId=17`;
    await sw.dispatch("fetch", { request: { method: "GET", url } });
    expect(sw.dataCache.put).toHaveBeenCalledWith(url, expect.any(Response));
    sw.fetch.mockRejectedValueOnce(new Error("Offline"));
    const response = await sw.dispatch("fetch", { request: { method: "GET", url } }) as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get("X-BW-Offline-Cached-At")).toBeTruthy();
    expect(await response.json()).toEqual({ forecast: null });
  });
  it.each(["/api/session", "/api/trpc/watches.list", "/api/forecasts/performance", "/api/forecasts?topicId=42&owner=private", "/api/markets?owner=private", "/api/forecasts/snapshot?snapshotId=17&owner=private", "/api/forecasts/snapshot?snapshotId=9007199254740992"])("does not intercept %s", path => {
    const sw = worker();
    expect(sw.dispatch("fetch", { request: { method: "GET", url: origin + path } })).toBeUndefined();
    expect(sw.fetch).not.toHaveBeenCalled();
  });
  it("does not intercept mutations or other origins", () => {
    const sw = worker();
    expect(sw.dispatch("fetch", { request: { method: "POST", url: `${origin}/api/forecasts?topicId=42` } })).toBeUndefined();
    expect(sw.dispatch("fetch", { request: { method: "GET", url: "https://other.example/api/markets" } })).toBeUndefined();
    expect(sw.fetch).not.toHaveBeenCalled();
  });
});

describe("build identity and update lifetime", () => {
  it("changes worker bytes for app-only releases and repeat builds, with matching shell identity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "weather-sw-"));
    try {
      const url = pathToFileURL(join(directory, "sw.js"));
      writeFileSync(url, source);
      writeFileSync(join(directory, "app.tsx"), "export default 'first app';");
      const firstVersion = generateServiceWorker(url);
      const first = readFileSync(url, "utf8");
      writeFileSync(join(directory, "app.tsx"), "export default 'changed app only';");
      const secondVersion = generateServiceWorker(url);
      const second = readFileSync(url, "utf8");
      expect(secondVersion).not.toBe(firstVersion);
      expect(second).not.toBe(first);
      expect(readWorkerVersion(url)).toBe(secondVersion);
      const sw = worker({ workerSource: second });
      await sw.dispatch("install");
      expect(sw.store.has(`${secondVersion}-shell`)).toBe(true);
      expect(generateServiceWorker(url)).not.toBe(secondVersion);
      const config = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
      expect(config).toContain("generateBuildId: async () => version");
      expect(config).toContain("NEXT_PUBLIC_SW_VERSION: version");
      const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
      expect(pkg.scripts.build).toBe("node scripts/build-service-worker.mjs");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("preserves stable and legacy public forecasts across activation and serves them offline", async () => {
    const sw = worker();
    const forecast = `${origin}/api/forecasts?topicId=42`;
    const snapshot = `${origin}/api/forecasts/snapshot?snapshotId=17`;
    await sw.dispatch("fetch", { request: { method: "GET", url: forecast } });
    await sw.open("bitcoin-weather-v4-public").put(snapshot, new Response('{"snapshot":17,"provenance":{"capturedAt":"2026-10-01T00:00:00.000Z"}}', { headers: { "X-BW-Stored-At": "2026-10-01T01:00:00.000Z" } }));
    const updated = worker({ workerSource: source.replace(/const VERSION = "[^"]+";/, 'const VERSION = "bitcoin-weather-next-build";'), store: sw.store });
    await updated.dispatch("activate");
    updated.fetch.mockRejectedValue(new Error("Offline"));
    const forecastResponse = await updated.dispatch("fetch", { request: { method: "GET", url: forecast } }) as Response;
    expect(await forecastResponse.json()).toEqual({ forecast: null });
    const snapshotResponse = await updated.dispatch("fetch", { request: { method: "GET", url: snapshot } }) as Response;
    expect(await snapshotResponse.json()).toEqual({ snapshot: 17, provenance: { capturedAt: "2026-10-01T00:00:00.000Z" } });
    expect(snapshotResponse.headers.get("X-BW-Offline-Cached-At")).toBe("2026-10-01T00:00:00.000Z");
    expect(updated.store.has("bitcoin-weather-v4-public")).toBe(false);
  });

  it("keeps old chunks until all controlled tabs confirm the current build", async () => {
    const sw = worker();
    const oldShell = "bitcoin-weather-previous-shell";
    const chunk = `${origin}/_next/static/old.js`;
    await sw.open(oldShell).put(chunk, new Response("old chunk"));
    sw.clients.matchAll.mockResolvedValue([{ id: "tab-a" }, { id: "tab-b" }]);
    await sw.dispatch("activate");
    expect(sw.store.has(oldShell)).toBe(true);
    sw.fetch.mockRejectedValue(new Error("Offline"));
    const response = await sw.dispatch("fetch", { request: { method: "GET", url: chunk } }) as Response;
    expect(await response.text()).toBe("old chunk");
    await sw.dispatch("message", { data: { type: "CLIENT_READY", version: sw.version }, source: { id: "tab-a" } });
    expect(sw.store.has(oldShell)).toBe(true);
    await sw.dispatch("message", { data: { type: "CLIENT_READY", version: "bitcoin-weather-previous" }, source: { id: "tab-b" } });
    expect(sw.store.has(oldShell)).toBe(true);
    await sw.dispatch("message", { data: { type: "CLIENT_READY", version: sw.version }, source: { id: "tab-b" } });
    expect(sw.store.has(oldShell)).toBe(false);
    expect(sw.store.has(`${sw.version}-shell`)).toBe(true);
    expect(sw.store.has("bitcoin-weather-public-v1")).toBe(true);
  });

  it("keeps the newest public snapshot when multiple legacy caches overlap", async () => {
    const sw = worker();
    const url = `${origin}/api/forecasts?topicId=42`;
    const snapshot = (day: string) => new Response(JSON.stringify({ day, provenance: { capturedAt: `2026-10-${day}T00:00:00.000Z` } }), { headers: { "X-BW-Stored-At": "2026-10-04T00:00:00.000Z" } });
    await sw.dataCache.put(url, snapshot("02"));
    await sw.open("bitcoin-weather-v3-public").put(url, snapshot("01"));
    await sw.open("bitcoin-weather-v4-public").put(url, snapshot("03"));
    await sw.dispatch("activate");
    expect(await (await sw.dataCache.match(url))!.json()).toEqual({ day: "03", provenance: { capturedAt: "2026-10-03T00:00:00.000Z" } });
  });
});

describe("tab controller changes", () => {
  // Load the actual component helper without mounting UI or requiring a DOM.
  const component = readFileSync(new URL("../src/components/PwaControls.tsx", import.meta.url), "utf8");
  const exports: { monitorControllerUpdates?: (container: ServiceWorkerContainer, reload: () => void, version: string) => () => void } = {};
  runInNewContext(ts.transpileModule(component, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports, require: () => ({}) });
  function tab(controlled = true) {
    let changed = () => {};
    const controller = { postMessage: vi.fn() };
    const container = { controller: controlled ? controller : null, addEventListener: vi.fn((_name, handler) => { changed = handler; }), removeEventListener: vi.fn() };
    const reload = vi.fn();
    const stop = exports.monitorControllerUpdates!(container as unknown as ServiceWorkerContainer, reload, "bitcoin-weather-current");
    return { container, reload, stop, change: () => changed() };
  }
  it("reloads both controlled tabs once, including the tab that did not request the update", () => {
    const tabs = [tab(), tab()];
    for (const current of tabs) {
      expect(current.container.controller?.postMessage).toHaveBeenCalledWith({ type: "CLIENT_READY", version: "bitcoin-weather-current" });
      current.container.controller = { postMessage: vi.fn() };
      current.change();
      current.change();
      expect(current.reload).toHaveBeenCalledTimes(1);
      expect(current.container.controller.postMessage).not.toHaveBeenCalled();
      current.stop();
      expect(current.container.removeEventListener).toHaveBeenCalledWith("controllerchange", expect.any(Function));
    }
  });
  it("does not reload on initial claim, but reloads on a subsequent update", () => {
    const current = tab(false);
    current.container.controller = { postMessage: vi.fn() };
    current.change();
    current.change();
    expect(current.reload).not.toHaveBeenCalled();
    expect(current.container.controller.postMessage).toHaveBeenCalledTimes(1);
    current.container.controller = { postMessage: vi.fn() };
    current.change();
    expect(current.reload).toHaveBeenCalledTimes(1);
  });
});
