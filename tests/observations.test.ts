import { afterEach, expect, it, vi } from "vitest";
import { openDatabase } from "../src/server/db";
import { collectPrices, parseCandles, saveCandles } from "../src/server/prices";
import { timeline } from "../src/server/timeline";
import { recordSnapshot, saveMarket } from "../src/server/store";
import { dailySlots, guideMidpoint, hourlySlots, projectionModel } from "../src/lib/projection";
import { market, quote } from "./fixtures";
import type { TimelineTarget } from "../src/lib/types";

const end = Date.parse("2026-10-02T08:00:00Z");
const candle = (start: number, close = "65000") => [start / 1000, "64000", "66000", "63000", close, "65000", "1", 2];
const payload = (rows: unknown[], key = "XXBTZUSD") => ({ error: [], result: { [key]: rows, last: end / 1000 } });
afterEach(() => vi.unstubAllEnvs());

it("aligns closed hourly/daily candle ends, excludes unfinished candles and validates schema/pair", () => {
  const hourly = parseCandles(payload([candle(end - 3600000), candle(end)]), "hourly", end + 1000);
  expect(hourly).toHaveLength(1); expect(hourly[0].observation.candleEnd).toBe(new Date(end).toISOString());
  const midnight = Date.parse("2026-10-02T00:00:00Z");
  expect(parseCandles(payload([candle(midnight - 86400000)], "XBTUSD"), "daily", end)[0].observation.candleEnd).toBe(new Date(midnight).toISOString());
  for (const invalid of [payload([candle(end - 3600000)], "ETHUSD"), payload([candle(end - 3599000)]), payload([candle(end - 3600000, "NaN")]), payload([candle(end - 3600000, "-1")]), { result: {} }]) expect(() => parseCandles(invalid, "hourly", end)).toThrow();
});

it("preserves first observation and separate captured provider revisions", () => {
  const db = openDatabase(":memory:");
  try {
    saveCandles(db, parseCandles(payload([candle(end - 3600000)]), "hourly", end));
    saveCandles(db, parseCandles(payload([candle(end - 3600000, "66000")]), "hourly", end + 1000));
    saveCandles(db, parseCandles(payload([candle(end - 3600000, "66000")]), "hourly", end + 2000));
    expect(db.prepare("SELECT value FROM provider_prices").get()).toEqual({ value: 65000 });
    expect(db.prepare("SELECT count(*) n FROM provider_price_versions").get()).toEqual({ n: 2 });
  } finally { db.close(); }
});

it("accepts Kraken's 720 closed candles plus its unfinished row without storing the unfinished close", () => {
  const rows = Array.from({ length: 721 }, (_, i) => candle(end - (720 - i) * 3600000));
  const parsed = parseCandles(payload(rows), "hourly", end + 1000);
  expect(parsed).toHaveLength(720);
  expect(parsed.at(-1)?.observation.candleEnd).toBe(new Date(end).toISOString());
  expect(() => parseCandles(payload(rows), "hourly", end + 3600000)).toThrow("closed history limit");
  expect(() => parseCandles(payload([...rows, candle(end + 3600000)]), "hourly", end)).toThrow("provider history limit");
});

it("uses saved pre-target snapshots, shows actual-only slots, and compares first future to observed", () => {
  vi.stubEnv("DEMO_MODE", "false");
  const db = openDatabase(":memory:");
  try {
    const m = { ...market, targetAt: new Date(end).toISOString() };
    saveMarket(db, m);
    const raw = { ...quote(), market_end_time_utc: end / 1000 };
    const frozen = recordSnapshot(db, m, raw, end - 3600000 - 1000)!;
    recordSnapshot(db, m, raw, end - 1000); // Inside the one-minute exclusion window.
    saveCandles(db, parseCandles(payload([candle(end - 7200000), candle(end - 3600000)]), "hourly", end));
    const next = { ...market, topicId: 999, targetAt: new Date(end + 3600000).toISOString() };
    saveMarket(db, next); recordSnapshot(db, next, { ...quote(), topic_id: 999, market_end_time_utc: (end + 3600000) / 1000 }, end);
    const data = timeline(db, { cadence: "hourly" }, end);
    expect(data.targets).toHaveLength(4);
    expect(data.targets[2].archive?.snapshotId).toBe(frozen.snapshotId);
    expect(data.targets[1].market).toBeNull(); expect(data.targets[1].forecast).toBeNull(); expect(data.targets[1].observed?.value).toBe(65000);
    const model = projectionModel(data, end, false, "range");
    expect(model.columns[1].available).toBe(false); expect(guideMidpoint(model.columns[1], "range")).toBe(65000);
    expect(model.columns[2].available).toBe(true); expect(model.columns[3].direction).not.toBe("unavailable");
    expect(hourlySlots(model.columns, end, 3).slice(0, 3).every(s => s.column?.kind === "past")).toBe(true);
    expect(model.lower).toBeLessThanOrEqual(65000); expect(model.upper).toBeGreaterThanOrEqual(65000);
    expect(projectionModel(data, end + 600000, true, "range").columns[2].available).toBe(true);
    expect(timeline(db, { cadence: "daily" }, end).targets.every(r => r.forecast === null)).toBe(true);
    const daily = projectionModel(timeline(db, { cadence: "daily" }, end), end, false, "range");
    expect(dailySlots(daily.columns, end, 3)).toHaveLength(6);
    expect(() => timeline(db, { pastCount: 8 }, end)).toThrow();
  } finally { db.close(); }
});

it("paces two hardcoded public calls, survives failures and retains stored history", async () => {
  const db = openDatabase(":memory:");
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
  try {
    saveCandles(db, parseCandles(payload([candle(end - 3600000)]), "hourly", end));
    await collectPrices(db, new AbortController().signal, () => true, fetcher, end);
    await collectPrices(db, new AbortController().signal, () => true, fetcher, end + 1000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await collectPrices(db, new AbortController().signal, () => true, fetcher, end + 300000);
    expect(fetcher).toHaveBeenCalledTimes(2); // First failed attempt backs off for ten minutes.
    await collectPrices(db, new AbortController().signal, () => true, fetcher, end + 600000);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith("https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval="))).toBe(true);
    expect(db.prepare("SELECT count(*) n FROM provider_prices").get()).toEqual({ n: 1 });
  } finally { db.close(); }
});

it("validates both archive policies and original capture metadata independently of missing observations", () => {
  vi.stubEnv("DEMO_MODE", "false");
  const db = openDatabase(":memory:");
  try {
    const m = { ...market, targetAt: new Date(end).toISOString() };
    saveMarket(db, m);
    recordSnapshot(db, m, { ...quote(), market_end_time_utc: end / 1000 }, end - 90000);
    const data = timeline(db, { cadence: "hourly", pastCount: 1 }, end);
    const original = data.targets[0];
    const column = (r: TimelineTarget, asOf = data.asOf) => projectionModel({ ...data, asOf, targets: [r] }, end + 600000, true, "range").columns[0];
    expect(column(original)).toMatchObject({ available: true, observed: null });
    for (const archive of [
      { ...original.archive!, snapshotId: -1 },
      { ...original.archive!, leadSeconds: 3600 },
      { ...original.archive!, maxSnapshotAgeSeconds: 300 },
      { ...original.archive!, cutoff: new Date(end).toISOString() },
      { ...original.archive!, capturedAt: new Date(end - 80000).toISOString() },
    ]) expect(column({ ...original, archive }).available).toBe(false);
    expect(column({ ...original, provenance: undefined }).available).toBe(false);
    expect(column({ ...original, archive: { ...original.archive!, capturedAt: undefined } as TimelineTarget["archive"] }).available).toBe(false);
    expect(column({ ...original, provenance: { ...original.provenance!, capturedAt: new Date(end).toISOString() } }).available).toBe(false);
    expect(column(original, new Date(end - 1).toISOString()).available).toBe(false);
    for (const captured of [end - 59999, end, end + 1, end - 14400001]) {
      const capturedAt = new Date(captured).toISOString();
      expect(column({ ...original, forecast: { ...original.forecast!, capturedAt }, provenance: { ...original.provenance!, capturedAt }, archive: { ...original.archive!, policy: "latest-valid-pre-target", capturedAt, leadSeconds: (end - captured) / 1000 } }).available).toBe(false);
    }
    const capturedAt = new Date(end - 3601000).toISOString();
    const legacy: TimelineTarget = { ...original, forecast: { ...original.forecast!, capturedAt }, provenance: { ...original.provenance!, capturedAt }, archive: { snapshotId: original.forecast!.snapshotId, leadSeconds: 3600, maxSnapshotAgeSeconds: 300, cutoff: new Date(end - 3600000).toISOString() } };
    expect(column(legacy).available).toBe(true);
    expect(column({ ...legacy, archive: { ...legacy.archive!, policy: "fixed-lead" } }).available).toBe(true);
    expect(column({ ...legacy, forecast: { ...legacy.forecast!, capturedAt: new Date(end - 3599999).toISOString() }, provenance: undefined }).available).toBe(false);
    const futureAt = new Date(end + 3600000).toISOString();
    const future: TimelineTarget = { ...original, kind: "future", archive: undefined, targetAt: futureAt, market: { ...m, targetAt: futureAt }, forecast: { ...original.forecast!, targetAt: futureAt, capturedAt: new Date(end).toISOString() }, freshUntil: new Date(end + 300000).toISOString() };
    const gap = projectionModel({ ...data, targets: [original, future] }, end, false, "range");
    expect(gap.columns.every(c => c.available)).toBe(true);
    expect(gap.columns[1].direction).toBe("unavailable"); // Missing close breaks the actual comparison, not archived bands.
  } finally { db.close(); }
});
