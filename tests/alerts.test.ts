import { describe, expect, it } from "vitest";
import { observeAlert, processAlerts, queueMessage, type AlertState } from "../src/server/alerts";
import { openDatabase } from "../src/server/db";
import { recordSnapshot, saveMarket } from "../src/server/store";
import { market, now, quote, watch } from "./fixtures";
const initial: AlertState = { baseline: null, candidateMs: null, candidateDirection: null, lastObservedMs: null, notifiedMs: null };
const target = now + 7200000;
describe("material change persistence", () => {
  it("requires two observations spaced 60 seconds and respects cooldown", () => {
    const baseline = observeAlert(initial, 0.2, watch, now, target, now).state;
    const candidate = observeAlert(baseline, 0.3, watch, now + 1000, target, now + 1000);
    expect(candidate.notify).toBe(false);
    expect(observeAlert(candidate.state, 0.3, watch, now + 59000, target, now + 59000).notify).toBe(false);
    const fired = observeAlert(candidate.state, 0.3, watch, now + 61000, target, now + 61000);
    expect(fired.notify).toBe(true); expect(fired.state.baseline).toBe(0.3);
    expect(observeAlert({ ...candidate.state, notifiedMs: now + 60000 }, 0.3, watch, now + 61000, target, now + 61000).notify).toBe(false);
  });
  it("suppresses stale, expired, repeated and interrupted observations", () => {
    const state = { ...initial, baseline: 0.2, candidateMs: now, candidateDirection: 1, lastObservedMs: now };
    expect(observeAlert(state, 0.4, watch, now, target, now + 301000).notify).toBe(false);
    expect(observeAlert(state, 0.4, watch, target, target, target).notify).toBe(false);
    expect(observeAlert(state, 0.4, watch, now, target, now).notify).toBe(false);
    expect(observeAlert(state, 0.2, watch, now + 61000, target, now + 61000).state.candidateMs).toBeNull();
    expect(observeAlert(state, 0.4, watch, now + 301000, target, now + 301000).notify).toBe(false);
    expect(observeAlert(state, 0.1, watch, now + 61000, target, now + 61000).notify).toBe(false);
  });
  it("atomically updates the baseline and deduplicates watch/snapshot outbox entries", () => {
    const db = openDatabase(":memory:");
    try {
      saveMarket(db, market); db.prepare("INSERT INTO installations VALUES('owner',?)").run(now);
      db.prepare("INSERT INTO watches(id,owner,data) VALUES('watch','owner',?)").run(JSON.stringify({ ...watch, createdAt: new Date(now).toISOString() }));
      const first = recordSnapshot(db, market, quote(), now)!; processAlerts(db, first, now);
      const second = recordSnapshot(db, market, quote([20, 50, 30]), now + 60000)!; processAlerts(db, second, now + 60000);
      const third = recordSnapshot(db, market, quote([20, 50, 30]), now + 120000)!; processAlerts(db, third, now + 120000); processAlerts(db, third, now + 120000);
      expect(db.prepare("SELECT COUNT(*) AS n FROM outbox").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT baseline FROM watches").get()).toEqual({ baseline: 0.3 });
      const row = db.prepare("SELECT payload FROM outbox").get() as { payload: string };
      expect(JSON.parse(row.payload)).toMatchObject({ title: "BTC glance", body: `Market quote share for closing above $2000: 20.0% to 30.0%. Target ${third.targetAt}.`, snapshotId: third.snapshotId, event: { operator: "above", threshold: 2000, previousProbability: 0.2, probability: 0.3 }, url: `/?topicId=123&snapshotId=${third.snapshotId}` });
      expect(queueMessage(db, "owner", {}, now, "watch", third.snapshotId)).toBe(false);
    } finally { db.close(); }
  });
});
