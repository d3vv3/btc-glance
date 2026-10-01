import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, openDatabase } from "../src/server/db";
import { saveMarket, recordSnapshot } from "../src/server/store";
import { timeline, timelineInputSchema } from "../src/server/timeline";
import { appRouter } from "../src/server/router";
import { market, now, quote, watch } from "./fixtures";
import { GET } from "../src/app/api/forecasts/timeline/route";

vi.mock("../src/server/db", async importOriginal => ({ ...await importOriginal<typeof import("../src/server/db")>(), getDb: vi.fn() }));

describe("public timeline", () => {
  beforeEach(() => { vi.stubEnv("DEMO_MODE", "false"); vi.stubEnv("STALE_SECONDS", "300"); vi.useFakeTimers(); vi.setSystemTime(now); });
  afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
  it("bounds homogeneous targets, preserves exact evidence and excludes future captures as of the query", () => {
    const db = openDatabase(":memory:");
    try {
      for (let i = 0; i < 35; i++) {
        const m = { ...market, topicId: 123 + i, targetAt: new Date(now + (i + 1) * 3600000).toISOString() };
        saveMarket(db, m); recordSnapshot(db, m, { ...quote(), topic_id: m.topicId, market_end_time_utc: Date.parse(m.targetAt) / 1000 }, now);
      }
      const daily = { ...market, topicId: 500, cadence: "daily" as const }; saveMarket(db, daily);
      saveMarket(db, { ...market, topicId: 501, source: "demo" });
      recordSnapshot(db, { ...market, targetAt: new Date(now + 3600000).toISOString() }, { ...quote([10, 80, 10]), market_end_time_utc: (now + 3600000) / 1000 }, now + 1000);
      const result = timeline(db, {}, now);
      expect(result.targets).toHaveLength(32); expect(result.cadence).toBe("hourly"); expect(result.asOf).toBe(new Date(now).toISOString());
      expect(result.targets[0].forecast?.summary.modalBucket.probability).toBe(.6);
      expect(result.targets[0].forecast?.capturedAt).toBe(new Date(now).toISOString());
      expect(result.targets[0].freshUntil).toBe(new Date(now + 300000).toISOString());
      expect(result.targets.every(r => r.market?.cadence === "hourly" && r.market.source === "live")).toBe(true);
      expect(timeline(db, { cadence: "daily", limit: 1 }, now).targets[0].status).toBe("unavailable");
    } finally { db.close(); }
  });
  it("keeps stale and invalid targets as explicit gaps instead of using older valid forecasts", () => {
    const db = openDatabase(":memory:");
    try {
      saveMarket(db, market); recordSnapshot(db, market, quote(), now - 301000);
      expect(timeline(db, {}, now).targets[0].status).toBe("stale");
      recordSnapshot(db, market, quote([20, -1, 20]), now);
      const r = timeline(db, {}, now).targets[0];
      expect(r.status).toBe("invalid"); expect(r.forecast).toBeNull(); expect(r.provenance?.raw).toEqual(quote([20, -1, 20]));
      expect(timeline(db, {}, now + 7200000).targets).toEqual([]);
    } finally { db.close(); }
  });
  it("is public without making owned watch records public", async () => {
    const db = openDatabase(":memory:");
    try {
      saveMarket(db, market); recordSnapshot(db, market, quote(), now);
      db.prepare("INSERT INTO installations VALUES('a',1)").run();
      db.prepare("INSERT INTO watches(id,owner,data,baseline) VALUES('private','a',?,.2)").run(JSON.stringify({ ...watch, createdAt: "saved" }));
      const caller = appRouter.createCaller({ db, request: new Request("http://localhost:3000"), owner: null });
      const result = await caller.forecasts.timeline({ cadence: "hourly", limit: 2 });
      expect(result.targets).toHaveLength(1); expect(JSON.stringify(result)).not.toContain("baseline"); expect(JSON.stringify(result)).not.toContain("private");
      await expect(caller.watches.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    } finally { db.close(); }
  });
  it.each([{ limit: 0 }, { limit: 33 }, { limit: 1.5 }, { cadence: "weekly" }, { owner: "private" }])("rejects unsupported input %j", input => { expect(timelineInputSchema.safeParse(input).success).toBe(false); });
  it("serves exact public GET schemas and rejects duplicate or private parameters", async () => {
    const db = openDatabase(":memory:");
    try {
      vi.mocked(getDb).mockReturnValue(db); saveMarket(db, market); recordSnapshot(db, market, quote(), now);
      const response = GET(new Request("http://localhost:3000/api/forecasts/timeline?cadence=hourly&limit=1"));
      expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ cadence: "hourly", asOf: new Date(now).toISOString(), targets: [{ forecast: { capturedAt: new Date(now).toISOString() } }] });
      for (const search of ["?limit=0", "?limit=33", "?limit=01", "?limit=1.5", "?cadence=weekly", "?cadence=hourly&cadence=daily", "?owner=private", "?limit=1&limit=2"]) expect(GET(new Request("http://localhost:3000/api/forecasts/timeline" + search)).status).toBe(400);
    } finally { db.close(); }
  });
});
