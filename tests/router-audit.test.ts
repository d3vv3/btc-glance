import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/server/db";
import { appRouter } from "../src/server/router";
import { latestForecast, recordSnapshot, saveMarket } from "../src/server/store";
import { market, now, quote, watch } from "./fixtures";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const endpoint = "https://fcm.googleapis.com/fcm/send/token";
const request = new Request("http://localhost:3000", { headers: { origin: "http://localhost:3000" } });

describe("audit router regressions", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv("APP_ORIGIN", "http://localhost:3000"); vi.stubEnv("STALE_SECONDS", "300"); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it.each(["stale", "invalid", "expired", "unavailable"] as const)("allows only unchanged disabling with a %s forecast", async status => {
    const db = openDatabase(":memory:");
    try {
      db.prepare("INSERT INTO installations VALUES('a',1),('b',1)").run();
      saveMarket(db, market);
      if (status !== "unavailable") recordSnapshot(db, market, status === "invalid" ? quote([20, -1, 20]) : quote(), now);
      vi.setSystemTime(status === "stale" ? now + 301000 : status === "expired" ? now + 7200000 : now);
      expect(latestForecast(db, market.topicId).status).toBe(status);
      db.prepare("INSERT INTO watches(id,owner,data,baseline,candidate_ms,notified_ms) VALUES(?,'a',?,0.2,1,1)").run(id, JSON.stringify({ ...watch, createdAt: "saved" }));
      db.prepare("INSERT INTO outbox(watch_id,owner,payload,created_ms) VALUES(?,'a','{}',1)").run(id);
      const caller = appRouter.createCaller({ db, request, owner: "a" });
      await expect(appRouter.createCaller({ db, request, owner: "b" }).watches.update({ id, ...watch, enabled: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(caller.watches.update({ id, ...watch, enabled: false })).resolves.toMatchObject({ enabled: false, createdAt: "saved", baseline: null });
      expect(db.prepare("SELECT candidate_ms,notified_ms FROM watches WHERE id=?").get(id)).toEqual({ candidate_ms: null, notified_ms: null });
      expect(db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE watch_id=?").get(id)).toEqual({ n: 0 });
      await expect(caller.watches.update({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", ...watch, enabled: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(caller.watches.update({ id, ...watch, enabled: false })).resolves.toMatchObject({ enabled: false });
      await expect(caller.watches.update({ id, ...watch })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      for (const change of [{ threshold: 1000 }, { materialPp: 6 }, { cooldownSeconds: 120 }, { operator: "below" as const }, { topicId: 456 }]) {
        await expect(caller.watches.update({ id, ...watch, enabled: false, ...change })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      }
      await expect(caller.watches.create({ ...watch, enabled: false })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(await caller.watches.list()).toMatchObject([{ enabled: false, threshold: watch.threshold }]);
    } finally { db.close(); }
  });

  it("still permits valid edits and activation and rejects invalid boundaries", async () => {
    const db = openDatabase(":memory:");
    try {
      db.prepare("INSERT INTO installations VALUES('a',1)").run(); saveMarket(db, market); recordSnapshot(db, market, quote(), now);
      const caller = appRouter.createCaller({ db, request, owner: "a" });
      const created = await caller.watches.create(watch);
      await caller.watches.update({ ...created, enabled: false });
      await expect(caller.watches.update({ ...created, materialPp: 6 })).resolves.toMatchObject({ enabled: true, materialPp: 6 });
      await expect(caller.watches.update({ ...created, threshold: 999, enabled: false })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    } finally { db.close(); }
  });

  it("returns only an installation-scoped boolean for a validated push endpoint", async () => {
    const db = openDatabase(":memory:");
    try {
      db.prepare("INSERT INTO installations VALUES('a',1),('b',1)").run();
      db.prepare("INSERT INTO subscriptions VALUES(?,'a',?)").run(endpoint, JSON.stringify({ endpoint, keys: { auth: "secret", p256dh: "secret" } }));
      const caller = (owner: string | null) => appRouter.createCaller({ db, request, owner });
      await expect(caller(null).push.status({ endpoint })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      expect(await caller("a").push.status({ endpoint })).toBe(true);
      expect(await caller("b").push.status({ endpoint })).toBe(false);
      expect(await caller("a").push.status({ endpoint: `${endpoint}-missing` })).toBe(false);
      for (const endpoint of ["", "https://localhost/token", "http://fcm.googleapis.com/token", "https://user:password@fcm.googleapis.com/token", "https://fcm.googleapis.com/token#fragment", "x".repeat(2049)]) {
        await expect(caller("a").push.status({ endpoint })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      }
      await expect(caller("a").push.status({ endpoint, keys: {} } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await caller("a").push.unregister({ endpoint });
      expect(await caller("a").push.status({ endpoint })).toBe(false);
    } finally { db.close(); }
  });

  it("captures the configured freshness allowance rather than a fixed five minutes", async () => {
    const db = openDatabase(":memory:");
    try {
      vi.stubEnv("STALE_SECONDS", "120"); saveMarket(db, market); recordSnapshot(db, market, quote(), now);
      const caller = appRouter.createCaller({ db, request, owner: null });
      expect(await caller.forecasts.freshness()).toEqual({ maxAgeSeconds: 120 });
      expect(await caller.forecasts.latest({ topicId: market.topicId })).toMatchObject({ status: "ready", freshUntil: new Date(now + 120000).toISOString() });
    } finally { db.close(); }
  });
});
