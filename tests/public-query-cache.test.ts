import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidatePublicReads, publicPerformance, publicRead } from "../src/client/api";
import { PublicQueryCache } from "../src/client/query-cache";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};
const evidence = {
  status: "ready", freshUntil: "2026-10-02T10:05:00Z", asOf: "2026-10-02T10:00:00Z",
  forecast: { capturedAt: "2026-10-02T10:00:00Z", source: "live", transformationVersion: "quote-share-v1", buckets: [{ probability: .5 }] },
};
const response = () => Response.json(evidence, { headers: { "X-BW-Offline-Cached-At": "2026-10-02T10:00:00Z" } });

describe("shared public reads", () => {
  const fetcher = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-02T10:00:00Z"));
    invalidatePublicReads(); fetcher.mockReset().mockImplementation(async () => response()); vi.stubGlobal("fetch", fetcher);
  });
  afterEach(() => { invalidatePublicReads(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("reuses reads across remounts and concurrent views without mutating evidence", async () => {
    const [first, second] = await Promise.all([publicRead<typeof evidence>("/api/forecasts?topicId=1"), publicRead<typeof evidence>("/api/forecasts?topicId=1")]);
    first.data.forecast.buckets[0].probability = 0;
    const remount = await publicRead<typeof evidence>("/api/forecasts?topicId=1");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second.data).toEqual(evidence); expect(remount.data).toEqual(evidence);
    expect(remount.cachedAt).toBe("2026-10-02T10:00:00Z");
    vi.setSystemTime(new Date("2026-10-02T10:00:59Z"));
    expect((await publicRead("/api/forecasts?topicId=1")).data).toEqual(evidence);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("canonicalizes query order and timeline defaults, keeping cadence, past count, limit and topic distinct", async () => {
    for (const path of ["/api/markets", "/api/markets", "/api/forecasts/timeline?cadence=hourly&limit=32", "/api/forecasts/timeline?pastCount=3&limit=32&cadence=hourly", "/api/forecasts/timeline?cadence=daily", "/api/forecasts/timeline?cadence=hourly", "/api/forecasts/timeline?cadence=hourly&limit=12", "/api/forecasts/timeline?cadence=hourly&pastCount=7", "/api/forecasts?topicId=1", "/api/forecasts?topicId=2", "/api/forecasts?topicId=1"]) await publicRead(path);
    expect(fetcher).toHaveBeenCalledTimes(7);
  });

  it("refreshes at the minute boundary and supports force and scoped invalidation", async () => {
    await publicRead("/api/markets");
    vi.advanceTimersByTime(60_000); await publicRead("/api/markets");
    await publicRead("/api/markets", undefined, { force: true });
    await publicRead("/api/forecasts?topicId=1");
    invalidatePublicReads("/api/markets"); await publicRead("/api/markets"); await publicRead("/api/forecasts?topicId=1");
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("keeps historical snapshots for 24 hours", async () => {
    await publicRead("/api/forecasts/snapshot?snapshotId=12");
    vi.advanceTimersByTime(23 * 60 * 60_000); await publicRead("/api/forecasts/snapshot?snapshotId=12");
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60 * 60_000); await publicRead("/api/forecasts/snapshot?snapshotId=12");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not cache failures", async () => {
    fetcher.mockResolvedValueOnce(new Response("Unavailable", { status: 503 }));
    await expect(publicRead("/api/markets")).rejects.toThrow("503");
    await publicRead("/api/markets"); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("lets one caller abort without poisoning another caller or the cached result", async () => {
    const pending = deferred<Response>(); fetcher.mockReturnValueOnce(pending.promise);
    const controller = new AbortController();
    const first = publicRead("/api/markets", controller.signal);
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const second = publicRead("/api/markets");
    controller.abort(); await rejected;
    pending.resolve(response()); await second; await publicRead("/api/markets");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].signal).toBeUndefined();
  });

  it("coalesces forced refreshes and never publishes an older flight after force", async () => {
    const older = deferred<Response>(); fetcher.mockReturnValueOnce(older.promise);
    const first = publicRead("/api/markets"); await Promise.resolve();
    const [fresh] = await Promise.all([publicRead("/api/markets", undefined, { force: true }), publicRead("/api/markets", undefined, { force: true })]);
    older.resolve(Response.json({ status: "old" })); await first;
    expect(await publicRead("/api/markets")).toEqual(fresh);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("wraps only the public performance query, with expiry and explicit refresh", async () => {
    const performance = { groups: [], metric: "multiclass-brier-original-bins", convention: "sum((p-y)^2), lower is better", source: "live" };
    fetcher.mockImplementation(async () => Response.json([{ result: { data: performance } }]));
    const first = Promise.all([publicPerformance(), publicPerformance()]);
    await vi.advanceTimersByTimeAsync(1); await first; await publicPerformance();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toContain("forecasts.performance");
    vi.advanceTimersByTime(60_000);
    const expired = publicPerformance(); await vi.advanceTimersByTimeAsync(1); await expired;
    const forced = publicPerformance({ force: true }); await vi.advanceTimersByTimeAsync(1); await forced;
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not cache unknown or private HTTP paths", async () => {
    await publicRead("/api/session"); await publicRead("/api/session");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("bounds the LRU at 128 keys and retains recently used keys", async () => {
    const cache = new PublicQueryCache(); const load = vi.fn(async () => ({ ok: true }));
    for (let i = 0; i < 128; i++) await cache.query(String(i), 60_000, load);
    await cache.query("0", 60_000, load); await cache.query("128", 60_000, load);
    await cache.query("0", 60_000, load); expect(load).toHaveBeenCalledTimes(129);
    await cache.query("1", 60_000, load); expect(load).toHaveBeenCalledTimes(130);
  });
});
