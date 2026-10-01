import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/server/db";
import { processAlerts } from "../src/server/alerts";
import { rateLimit } from "../src/server/security";
import { recordSnapshot, saveMarket } from "../src/server/store";
import { appRouter } from "../src/server/router";
import { market, now, quote, watch } from "./fixtures";

describe("read-write transaction locking", () => {
  it.each(["rate limit", "watch processing", "market identity", "snapshot definitions", "subscription quota"] as const)("takes the writer lock before reading %s", async operation => {
    const directory = mkdtempSync(path.join(tmpdir(), "weather-transactions-"));
    const db = openDatabase(path.join(directory, "test.sqlite"));
    const competing = openDatabase(path.join(directory, "test.sqlite"));
    competing.pragma("busy_timeout = 0");
    try {
      saveMarket(db, market); const forecast = recordSnapshot(db, market, quote(), now)!;
      db.prepare("INSERT INTO installations VALUES('owner',?)").run(now);
      db.prepare("INSERT INTO watches(id,owner,data) VALUES('watch','owner',?)").run(JSON.stringify(watch));
      const read = { "rate limit": "SELECT start_ms,count", "watch processing": "SELECT * FROM watches", "market identity": "SELECT data,winner", "snapshot definitions": "SELECT definitions", "subscription quota": "SELECT owner FROM subscriptions" }[operation]!;
      const prepare = db.prepare.bind(db); let intercepted = false;
      const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
        if (sql.startsWith(read)) {
          intercepted = true;
          // A deferred transaction allows this write before its first read; IMMEDIATE must reject it.
          expect(() => competing.prepare("INSERT OR REPLACE INTO worker_state VALUES('competitor','1')").run()).toThrow(/locked/);
        }
        return prepare(sql);
      }) as typeof db.prepare);
      if (operation === "rate limit") rateLimit(db, "test", 1, now);
      if (operation === "watch processing") processAlerts(db, forecast, now);
      if (operation === "market identity") saveMarket(db, market);
      if (operation === "snapshot definitions") recordSnapshot(db, market, quote(), now + 1);
      if (operation === "subscription quota") {
        vi.stubEnv("VAPID_PUBLIC_KEY", "public"); vi.stubEnv("VAPID_PRIVATE_KEY", "private");
        const caller = appRouter.createCaller({ db, owner: "owner", request: new Request("http://localhost:3000", { headers: { origin: "http://localhost:3000" } }) });
        await caller.push.register({ endpoint: "https://fcm.googleapis.com/fcm/send/token", keys: { auth: "a".repeat(22), p256dh: "a".repeat(87) } });
      }
      expect(intercepted).toBe(true);
      spy.mockRestore();
      expect(() => competing.prepare("INSERT OR REPLACE INTO worker_state VALUES('competitor','1')").run()).not.toThrow();
    } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); competing.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
