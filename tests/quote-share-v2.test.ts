import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { brier, thresholdProbability } from "../src/lib/forecast";
import { openDatabase } from "../src/server/db";
import { latestForecast, performance, recordSnapshot, saveMarket, snapshotForecast } from "../src/server/store";
import { timeline } from "../src/server/timeline";
import { appRouter } from "../src/server/router";
import { processAlerts } from "../src/server/alerts";
import { market, now, quote, watch } from "./fixtures";

const scaledQuote = (yes: number[]) => {
  const raw = quote(yes);
  (raw.outcomes as { no_price: number }[]).forEach(o => { o.no_price = 499; });
  return raw;
};

describe("prospective quote-share-v2 integration", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv("APP_ORIGIN", "http://localhost:3000"); vi.stubEnv("DEMO_MODE", "false"); vi.stubEnv("STALE_SECONDS", "300"); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("publishes 103-total evidence to latest/timeline/watch boundaries and alerts", async () => {
    const db = openDatabase(":memory:");
    try {
      saveMarket(db, market);
      const raw = scaledQuote([20, 63, 20]);
      const forecast = recordSnapshot(db, market, raw, now)!;
      expect(forecast).toMatchObject({ transformationVersion: "quote-share-v2", originalYesSum: 103, normalizationFactor: 100 / 103 });
      expect(forecast.caveat).toContain("YES quote / total YES quotes. Quotes may exceed100");
      expect(latestForecast(db, market.topicId, now)).toMatchObject({ status: "ready", diagnostics: [], forecast, provenance: { raw } });
      expect(timeline(db, { limit: 8, pastCount: 0 }, now).targets[0].forecast).toEqual(forecast);
      expect(thresholdProbability(forecast.buckets, "above", 1000).probability).toBeCloseTo(83 / 103);
      db.prepare("INSERT INTO installations VALUES('owner',?)").run(now);
      const caller = appRouter.createCaller({ db, owner: "owner", request: new Request("http://localhost:3000", { headers: { origin: "http://localhost:3000" } }) });
      const created = await caller.watches.create(watch);
      processAlerts(db, forecast, now);
      for (const offset of [1000, 61000]) {
        const changed = recordSnapshot(db, market, scaledQuote([100, 100, 300]), now + offset)!;
        processAlerts(db, changed, now + offset);
      }
      const messages = db.prepare("SELECT owner,payload FROM outbox WHERE watch_id=?").all(created.id) as { owner: string; payload: string }[];
      expect(messages).toHaveLength(1); expect(messages[0].owner).toBe("owner");
      expect(JSON.parse(messages[0].payload)).toMatchObject({ body: expect.stringContaining("Market quote share"), event: { probability: .6 } });
      expect(snapshotForecast(db, forecast.snapshotId).forecast).toEqual(forecast);
    } finally { db.close(); }
  });

  it("keeps frozen v1 and historically rejected data unchanged; scores saved v2 shares", () => {
    const db = openDatabase(":memory:");
    try {
      saveMarket(db, market);
      const old = recordSnapshot(db, market, quote(), now)!;
      const v1 = { ...old, transformationVersion: "quote-share-v1", caveat: "Frozen historical caveat" };
      db.prepare("UPDATE snapshots SET forecast=? WHERE id=?").run(JSON.stringify(v1), old.snapshotId);
      const historical = recordSnapshot(db, market, scaledQuote([20, 58, 20]), now + 1)!;
      db.prepare("UPDATE snapshots SET forecast=NULL,diagnostics=? WHERE id=?").run(JSON.stringify([{ code: "total-sum", message: "Historical v1 rejection" }]), historical.snapshotId);
      const before = db.prepare("SELECT * FROM snapshots ORDER BY id").all();
      const fresh = recordSnapshot(db, market, scaledQuote([20, 63, 20]), now + 3600000 - 60000)!;
      expect(db.prepare("SELECT * FROM snapshots WHERE id<=? ORDER BY id").all(historical.snapshotId)).toEqual(before);
      expect(snapshotForecast(db, old.snapshotId).forecast).toEqual(v1);
      expect(snapshotForecast(db, historical.snapshotId)).toMatchObject({ status: "invalid", forecast: null, diagnostics: [{ code: "total-sum" }] });
      db.prepare("UPDATE markets SET winner=2 WHERE topic_id=?").run(market.topicId);
      const group = performance(db, now + 7200000).groups[0];
      expect(group.sampleCount).toBe(1);
      expect(group.samples[0]).toMatchObject({ snapshotId: fresh.snapshotId, transformationVersion: "quote-share-v2", brier: brier(fresh.buckets, 2) });
      expect(group.meanBrier).toBeCloseTo((20 / 103) ** 2 * 2 + (63 / 103 - 1) ** 2);
      const priorMarket = { ...market, topicId: 124, resolvedOptionId: 2 };
      saveMarket(db, priorMarket);
      const prior = recordSnapshot(db, priorMarket, { ...quote(), topic_id: 124 }, now + 3600000 - 120000)!;
      db.prepare("UPDATE snapshots SET forecast=? WHERE id=?").run(JSON.stringify({ ...prior, transformationVersion: "quote-share-v1" }), prior.snapshotId);
      const mixed = performance(db, now + 7200000).groups[0];
      expect(mixed.sampleCount).toBe(2);
      expect(mixed.samples.map(s => s.transformationVersion)).toEqual(["quote-share-v2", "quote-share-v1"]);
      expect(mixed.meanBrier).toBeCloseTo((group.meanBrier! + .24) / 2);
    } finally { db.close(); }
  });
});
