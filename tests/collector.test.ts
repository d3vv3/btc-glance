import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/server/db";
import { collect, pollResolutions } from "../src/server/collector";
import { BATCHES, GlimpseClient } from "../src/server/glimpse";
import { getMarket, saveMarket } from "../src/server/store";
import { market, now, quote, watch } from "./fixtures";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe("saved-ID resolution polling", () => {
  it("discovers and collects the next 14 daily plus 8 hourly targets with bounded discovery", async () => {
    const db = openDatabase(":memory:");
    vi.stubEnv("DEMO_MODE", "false"); vi.spyOn(Date, "now").mockReturnValue(now);
    const requests: string[] = [];
    class Client extends GlimpseClient {
      override async get(path: string): Promise<unknown> {
        requests.push(path);
        if (path.includes("/quotes")) {
          const id = Number(path.split("/").at(-2)); const m = getMarket(db, id)!;
          return { ...quote(), topic_id: id, batch_id: m.batchId, market_end_time_utc: Date.parse(m.targetAt) / 1000 };
        }
        const cadence = path.includes(BATCHES.daily) ? "daily" : "hourly";
        const offset = Number(new URL(`https://example.test${path}`).searchParams.get("offset"));
        return { has_more: true, next_offset: offset + 50, markets: Array.from({ length: 20 }, (_, i) => ({ topic_id: (cadence === "daily" ? 1000 : 2000) + offset + i, batch_id: BATCHES[cadence], title: "Bitcoin", end_time_utc: (now + (offset + i + 1) * (cadence === "daily" ? 86400000 : 3600000)) / 1000, num_outcomes: 3, is_active: true, is_resolved: false, outcomes: quote().outcomes })) };
      }
    }
    try {
      vi.spyOn(console, "error").mockImplementation(() => {});
      await collect(db, new Client(), now);
      expect(requests.filter(p => p.includes("active-markets"))).toHaveLength(16);
      const quotes = requests.filter(p => p.includes("/quotes"));
      expect(quotes).toHaveLength(22);
      expect(quotes.filter(p => getMarket(db, Number(p.split("/").at(-2)))?.cadence === "daily")).toHaveLength(14);
      expect(db.prepare("SELECT COUNT(*) AS n FROM snapshots WHERE forecast IS NOT NULL").get()).toEqual({ n: 22 });
      db.prepare("INSERT INTO installations VALUES('owner',?)").run(now);
      for (let i = 0; i < 21; i++) {
        const topicId = 3000 + i;
        saveMarket(db, { ...market, topicId, batchId: BATCHES.hourly, targetAt: new Date(now + (i + 9) * 3600000).toISOString() });
        db.prepare("INSERT INTO watches(id,owner,data) VALUES(?,'owner',?)").run(`extra-${i}`, JSON.stringify({ ...watch, topicId, enabled: i < 20 }));
      }
      // Duplicate watches do not consume capacity; disabled watch-only IDs do not enter it.
      db.prepare("INSERT INTO watches(id,owner,data) VALUES('duplicate','owner',?)").run(JSON.stringify({ ...watch, topicId: 3000 }));
      const passes: number[][] = [];
      for (let pass = 0; pass < 6; pass++) {
        const captured = now + pass * 60000;
        vi.mocked(Date.now).mockReturnValue(captured);
        requests.length = 0;
        const client = new Client();
        const get = client.get.bind(client);
        client.get = async path => {
          const raw = await get(path);
          return path.includes("/quotes") && pass >= 2 ? { ...raw as object, outcomes: quote([10, 50, 40]).outcomes } : raw;
        };
        await collect(db, client, captured);
        const ids = requests.filter(p => p.includes("/quotes")).map(p => Number(p.split("/").at(-2)));
        expect(ids).toHaveLength(32);
        expect(new Set(ids).size).toBe(32);
        expect(ids.filter(id => getMarket(db, id)?.cadence === "daily")).toHaveLength(14);
        expect(ids.filter(id => id >= 2000 && id < 3000)).toHaveLength(8);
        expect(ids).not.toContain(3020);
        passes.push(ids.filter(id => id >= 3000));
      }
      expect(passes[0]).toEqual(Array.from({ length: 10 }, (_, i) => 3000 + i));
      expect(passes[1]).toEqual(Array.from({ length: 10 }, (_, i) => 3010 + i));
      expect(passes[2]).toEqual(passes[0]);
      expect(db.prepare("SELECT value FROM worker_state WHERE key='watchCursor'").get()).toEqual({ value: "3019" });
      expect(db.prepare("SELECT COUNT(DISTINCT watch_id) AS n FROM outbox WHERE watch_id LIKE 'extra-%'").get()).toEqual({ n: 20 });
    } finally { db.close(); }
  });
  it.each(["abort", "lease"])("does not process a quote returned after %s loss", async loss => {
    const db = openDatabase(":memory:"); const controller = new AbortController(); let held = true;
    vi.stubEnv("DEMO_MODE", "false");
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      saveMarket(db, market);
      for (const cadence of ["hourly", "daily"]) db.prepare("INSERT INTO worker_state VALUES(?,?)").run(`discovery:${cadence}`, String(now));
      db.prepare("INSERT INTO installations VALUES('owner',?)").run(now);
      db.prepare("INSERT INTO watches(id,owner,data) VALUES('watch','owner',?)").run(JSON.stringify(watch));
      const requests: string[] = [];
      class Client extends GlimpseClient {
        override async get(path: string): Promise<unknown> {
          requests.push(path);
          if (loss === "abort") controller.abort(); else held = false;
          return quote();
        }
      }
      await collect(db, new Client(), now, { signal: controller.signal, hasLease: () => held });
      expect(requests).toHaveLength(1);
      expect(db.prepare("SELECT COUNT(*) AS n FROM snapshots").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT baseline FROM watches").get()).toEqual({ baseline: null });
      expect(db.prepare("SELECT value FROM worker_state WHERE key='lastCollection'").get()).toBeUndefined();
    } finally { db.close(); }
  });
  it("polls saved old IDs and advances a persistent feed cursor without reconstructing forecasts", async () => {
    const db = openDatabase(":memory:");
    vi.spyOn(Date, "now").mockReturnValue(now + 7200000);
    try {
      const saved = { ...market, batchId: BATCHES.hourly };
      const outcomes = quote().outcomes as { option_id: number; name: string }[];
      saveMarket(db, saved, outcomes);
      db.prepare("INSERT INTO worker_state VALUES('resolutionCursor:hourly','400')").run();
      const requests: string[] = [];
      class Client extends GlimpseClient {
        override async get(path: string): Promise<unknown> {
          requests.push(path);
          if (path.includes("/quotes")) return { ...quote(), batch_id: BATCHES.hourly, is_resolved: true };
          const offset = Number(new URL(`https://example.test${path}`).searchParams.get("offset"));
          return { has_more: true, next_offset: offset + 50, markets: [{ topic_id: 123, batch_id: BATCHES.hourly, title: "Bitcoin", end_time_utc: Date.parse(saved.targetAt) / 1000, num_outcomes: 3, is_active: false, is_resolved: true, resolved_option_id: 2, outcomes }] };
        }
      }
      await pollResolutions(db, new Client(), now + 7200000);
      expect(requests[0]).toContain("/markets/123/quotes");
      expect(requests[1]).toContain("offset=400"); expect(requests).toHaveLength(3);
      expect(getMarket(db, 123)?.resolvedOptionId).toBe(2);
      expect(db.prepare("SELECT value FROM worker_state WHERE key='resolutionCursor:hourly'").get()).toEqual({ value: "500" });
      expect(db.prepare("SELECT COUNT(*) AS n FROM snapshots WHERE forecast IS NOT NULL").get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });
});
