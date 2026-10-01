import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/server/db";
import { latestForecast, performance, recordSnapshot, saveMarket, snapshotForecast } from "../src/server/store";
import { market, now, quote } from "./fixtures";
describe("persistent provenance and prospective evaluation", () => {
  it("preserves latest valid provenance through ready, stale and expired statuses", () => {
    const db = openDatabase(":memory:");
    try {
      saveMarket(db, market);
      const forecast = recordSnapshot(db, market, quote(), now)!;
      const evidence = snapshotForecast(db, forecast.snapshotId).provenance;
      expect(evidence).toEqual({ snapshotId: forecast.snapshotId, capturedAt: new Date(now).toISOString(), raw: quote() });
      for (const [at, status] of [[now, "ready"], [now + 301000, "stale"], [now + 7200000, "expired"]] as const) {
        expect(latestForecast(db, market.topicId, at)).toMatchObject({ forecast, status, provenance: evidence });
      }
    } finally { db.close(); }
  });
  it("omits provenance when no market or snapshot exists", () => {
    const db = openDatabase(":memory:");
    try {
      expect(latestForecast(db, market.topicId, now)).toEqual({ market: null, forecast: null, status: "unavailable", diagnostics: [] });
      saveMarket(db, market);
      expect(latestForecast(db, market.topicId, now)).toEqual({ market, forecast: null, status: "unavailable", diagnostics: [] });
    } finally { db.close(); }
  });
  it("returns immutable snapshot evidence independent of newer quotes and market resolution", () => {
    const db = openDatabase(":memory:");
    try {
      saveMarket(db, market);
      const forecast = recordSnapshot(db, market, quote(), now)!;
      const evidence = snapshotForecast(db, forecast.snapshotId);
      expect(evidence).toMatchObject({ market, forecast, status: "ready", provenance: { snapshotId: forecast.snapshotId, capturedAt: forecast.capturedAt, raw: quote() } });
      recordSnapshot(db, market, quote([0, 100, 0]), now + 1000);
      saveMarket(db, { ...market, title: "Changed", resolvedOptionId: 2 });
      expect(snapshotForecast(db, forecast.snapshotId)).toEqual(evidence);
      expect(snapshotForecast(db, 999)).toEqual({ market: null, forecast: null, status: "unavailable", diagnostics: [] });
    } finally { db.close(); }
  });
  it("exposes raw provenance and diagnostics for an invalid snapshot", () => {
    const db = openDatabase(":memory:");
    try {
      saveMarket(db, market); const raw = quote([20, -1, 20]);
      recordSnapshot(db, market, raw, now);
      const result = snapshotForecast(db, 1);
      expect(result.status).toBe("invalid"); expect(result.forecast).toBeNull();
      expect(result.diagnostics.length).toBeGreaterThan(0); expect(result.provenance?.raw).toEqual(raw);
    } finally { db.close(); }
  });
  it("retains raw invalid snapshots without publishing an older valid distribution", () => {
    const db = openDatabase(":memory:");
    try {
      saveMarket(db, market); recordSnapshot(db, market, quote(), now);
      recordSnapshot(db, market, quote([20, -1, 20]), now + 1000);
      const latest = latestForecast(db, market.topicId, now + 1000);
      const evidence = snapshotForecast(db, 2);
      expect(latest.status).toBe("invalid");
      expect(latest.forecast).toBeNull();
      expect(latest.diagnostics).toEqual(evidence.diagnostics);
      expect(latest.provenance).toEqual(evidence.provenance);
      expect(latest.provenance).toEqual({ snapshotId: 2, capturedAt: new Date(now + 1000).toISOString(), raw: quote([20, -1, 20]) });
      recordSnapshot(db, market, quote(), now + 7200000);
      expect(latestForecast(db, market.topicId, now + 7200000)).toMatchObject({ status: "expired", forecast: null, provenance: evidence.provenance });
      expect(db.prepare("SELECT COUNT(*) AS n FROM snapshots WHERE raw IS NOT NULL").get()).toEqual({ n: 3 });
    } finally { db.close(); }
  });
  it("checks target, outcome identity, stale status and pre-target retention", () => {
    const db = openDatabase(":memory:");
    try {
      const definitions = (quote().outcomes as { option_id: number; name: string }[]).map(({ option_id, name }) => ({ option_id, name }));
      saveMarket(db, market, definitions); recordSnapshot(db, market, quote(), now);
      expect(latestForecast(db, 123, now + 301000).status).toBe("stale");
      expect(latestForecast(db, 123, now + 7200000).status).toBe("expired");
      const wrong = quote(); (wrong.outcomes as { option_id: number }[])[0].option_id = 99;
      expect(recordSnapshot(db, market, wrong, now + 1000)).toBeNull();
      expect(recordSnapshot(db, market, { ...quote(), market_end_time_utc: 1 }, now + 2000)).toBeNull();
      expect(recordSnapshot(db, market, quote(), now + 7200000)).toBeNull();
    } finally { db.close(); }
  });
  it("scores only a saved lead-time forecast, counts gaps and excludes demo", () => {
    const db = openDatabase(":memory:");
    try {
      saveMarket(db, market); recordSnapshot(db, market, quote(), now + 3600000 - 60000);
      recordSnapshot(db, market, quote([0, 100, 0]), now + 3600000 + 1);
      db.prepare("UPDATE markets SET winner=2 WHERE topic_id=123").run();
      saveMarket(db, { ...market, topicId: 124 });
      saveMarket(db, { ...market, topicId: 125, source: "demo" });
      const group = performance(db, now + 7200000).groups[0];
      expect(group.sampleCount).toBe(1); expect(group.eligibleCount).toBe(2); expect(group.missingSnapshotCount).toBe(1); expect(group.meanBrier).toBeCloseTo(0.24);
    } finally { db.close(); }
  });
  it("keeps the last prospective forecast available after resolution polling", () => {
    const db = openDatabase(":memory:");
    try {
      saveMarket(db, market);
      const forecast = recordSnapshot(db, market, quote(), now)!;
      recordSnapshot(db, market, { ...quote(), is_resolved: true }, now + 7200000);
      const result = latestForecast(db, market.topicId, now + 7200000);
      expect(result.status).toBe("expired"); expect(result.forecast?.snapshotId).toBe(forecast.snapshotId);
    } finally { db.close(); }
  });
});
