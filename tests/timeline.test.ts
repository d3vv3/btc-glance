import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, openDatabase } from "../src/server/db";
import { saveMarket, recordSnapshot, performance } from "../src/server/store";
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
      const result = timeline(db, { pastCount: 0 }, now);
      expect(result.targets).toHaveLength(32); expect(result.cadence).toBe("hourly"); expect(result.asOf).toBe(new Date(now).toISOString());
      expect(result.targets[0].forecast?.summary.modalBucket.probability).toBe(.6);
      expect(result.targets[0].forecast?.capturedAt).toBe(new Date(now).toISOString());
      expect(result.targets[0].freshUntil).toBe(new Date(now + 300000).toISOString());
      expect(result.targets.every(r => r.market?.cadence === "hourly" && r.market.source === "live")).toBe(true);
      expect(timeline(db, { cadence: "daily", limit: 1, pastCount: 0 }, now).targets[0].status).toBe("unavailable");
    } finally { db.close(); }
  });
  it("keeps stale and invalid targets as explicit gaps instead of using older valid forecasts", () => {
    const db = openDatabase(":memory:");
    try {
      saveMarket(db, market); recordSnapshot(db, market, quote(), now - 301000);
      expect(timeline(db, { pastCount: 0 }, now).targets[0].status).toBe("stale");
      recordSnapshot(db, market, quote([20, -1, 20]), now);
      const r = timeline(db, { pastCount: 0 }, now).targets[0];
      expect(r.status).toBe("invalid"); expect(r.forecast).toBeNull(); expect(r.provenance?.raw).toEqual(quote([20, -1, 20]));
      expect(timeline(db, { pastCount: 0 }, now + 7200000).targets).toEqual([]);
    } finally { db.close(); }
  });
  it.each(["hourly", "daily"] as const)("uses latest valid pre-target %s evidence without changing fixed-lead Brier scoring", cadence => {
    const db = openDatabase(":memory:");
    try {
      const target = now, lead = cadence === "hourly" ? 3600000 : 86400000;
      const m = { ...market, cadence, targetAt: new Date(target).toISOString(), resolvedOptionId: 2 };
      const raw = { ...quote(), market_end_time_utc: target / 1000 };
      saveMarket(db, m);
      const fixed = recordSnapshot(db, m, raw, target - lead)!;
      const before = performance(db, target);
      const lateRaw = { ...quote([10, 80, 10]), market_end_time_utc: target / 1000 };
      const latest = recordSnapshot(db, m, lateRaw, target - 90001)!;
      recordSnapshot(db, m, { ...quote([20, -1, 20]), market_end_time_utc: target / 1000 }, target - 70000);
      recordSnapshot(db, m, raw, target - 59999);
      expect(recordSnapshot(db, m, raw, target)).toBeNull();
      expect(recordSnapshot(db, m, raw, target + 1000)).toBeNull();
      const result = timeline(db, { cadence, pastCount: 1 }, target).targets[0];
      expect(result.forecast).toEqual(latest);
      expect(result.provenance).toEqual({ snapshotId: latest.snapshotId, capturedAt: latest.capturedAt, raw: lateRaw });
      expect(result.archive).toEqual({ policy: "latest-valid-pre-target", snapshotId: latest.snapshotId, capturedAt: latest.capturedAt, leadSeconds: 90.001, maxSnapshotAgeSeconds: cadence === "hourly" ? 14400 : 172800, cutoff: new Date(target - 60000).toISOString() });
      expect(performance(db, target)).toEqual(before);
      expect(before.groups.find(g => g.cadence === cadence)?.samples[0].snapshotId).toBe(fixed.snapshotId);
      expect(timeline(db, { cadence, pastCount: 1 }, target)).toEqual(timeline(db, { cadence, pastCount: 1 }, target));
    } finally { db.close(); }
  });
  it.each(["hourly", "daily"] as const)("bounds %s visual archives by target age and includes the exact one-minute cutoff", cadence => {
    const db = openDatabase(":memory:");
    try {
      const age = cadence === "hourly" ? 14400000 : 172800000;
      const m = { ...market, cadence, targetAt: new Date(now).toISOString() };
      const raw = { ...quote(), market_end_time_utc: now / 1000 };
      saveMarket(db, m);
      recordSnapshot(db, m, raw, now - age - 1);
      expect(timeline(db, { cadence, pastCount: 1 }, now).targets[0].forecast).toBeNull();
      const oldest = recordSnapshot(db, m, raw, now - age)!;
      expect(timeline(db, { cadence, pastCount: 1 }, now).targets[0].forecast).toEqual(oldest);
      const cutoff = recordSnapshot(db, m, raw, now - 60000)!;
      const tied = recordSnapshot(db, m, raw, now - 60000)!;
      expect(tied.snapshotId).toBeGreaterThan(cutoff.snapshotId);
      expect(timeline(db, { cadence, pastCount: 1 }, now).targets[0].forecast).toEqual(tied);
      expect(performance(db, now).groups.find(g => g.cadence === cadence)).toMatchObject({ sampleCount: 0, missingSnapshotCount: 1 });
    } finally { db.close(); }
  });
  it("is public without making owned watch records public", async () => {
    const db = openDatabase(":memory:");
    try {
      saveMarket(db, market); recordSnapshot(db, market, quote(), now);
      db.prepare("INSERT INTO installations VALUES('a',1)").run();
      db.prepare("INSERT INTO watches(id,owner,data,baseline) VALUES('private','a',?,.2)").run(JSON.stringify({ ...watch, createdAt: "saved" }));
      const caller = appRouter.createCaller({ db, request: new Request("http://localhost:3000"), owner: null });
      const result = await caller.forecasts.timeline({ cadence: "hourly", limit: 2, pastCount: 0 });
      expect(result.targets).toHaveLength(1); expect(JSON.stringify(result)).not.toContain("baseline"); expect(JSON.stringify(result)).not.toContain("private");
      await expect(caller.watches.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    } finally { db.close(); }
  });
  it.each([{ limit: 0 }, { limit: 33 }, { limit: 1.5 }, { cadence: "weekly" }, { owner: "private" }])("rejects unsupported input %j", input => { expect(timelineInputSchema.safeParse(input).success).toBe(false); });
  it("serves exact public GET schemas and rejects duplicate or private parameters", async () => {
    const db = openDatabase(":memory:");
    try {
      vi.mocked(getDb).mockReturnValue(db); saveMarket(db, market); recordSnapshot(db, market, quote(), now);
      const response = GET(new Request("http://localhost:3000/api/forecasts/timeline?cadence=hourly&limit=1&pastCount=0"));
      expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ cadence: "hourly", asOf: new Date(now).toISOString(), targets: [{ forecast: { capturedAt: new Date(now).toISOString() } }] });
      for (const search of ["?limit=0", "?limit=33", "?limit=01", "?limit=1.5", "?cadence=weekly", "?cadence=hourly&cadence=daily", "?owner=private", "?limit=1&limit=2"]) expect(GET(new Request("http://localhost:3000/api/forecasts/timeline" + search)).status).toBe(400);
    } finally { db.close(); }
  });
});
