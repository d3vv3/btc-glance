import { afterEach, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import { openDatabase, workerLeaseHeld } from "../src/server/db";
import { queueMessage } from "../src/server/alerts";
import { deliverPush } from "../src/server/push";
import { now, watch } from "./fixtures";
vi.mock("web-push", () => ({ default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() } }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
function setup() {
  vi.stubEnv("VAPID_PUBLIC_KEY", "public"); vi.stubEnv("VAPID_PRIVATE_KEY", "private");
  const db = openDatabase(":memory:");
  const endpoint = "https://fcm.googleapis.com/fcm/send/token";
  db.prepare("INSERT INTO installations VALUES('owner',?)").run(now);
  db.prepare("INSERT INTO subscriptions VALUES(?,'owner',?)").run(endpoint, JSON.stringify({ endpoint, keys: { auth: "auth", p256dh: "key" } }));
  queueMessage(db, "owner", { title: "Bitcoin Weather" }, now);
  return db;
}
describe("outbox delivery", () => {
  it("stops a batch when aborted while its first send is pending", async () => {
    const db = setup(); const controller = new AbortController();
    try {
      queueMessage(db, "owner", { title: "second" }, now);
      let finish!: (value: Awaited<ReturnType<typeof webpush.sendNotification>>) => void;
      vi.mocked(webpush.sendNotification).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
      const delivery = deliverPush(db, () => now, { signal: controller.signal });
      expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
      controller.abort(); finish({ statusCode: 201, body: "", headers: {} }); await delivery;
      expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
      expect(db.prepare("SELECT SUM(done) AS n FROM deliveries").get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });
  it.each(["taken", "expired"])("stops a batch when the worker lease is %s", async loss => {
    const db = setup(); let clock = now;
    try {
      db.prepare("INSERT INTO worker_state VALUES('lease',?)").run(JSON.stringify({ owner: "worker", expires: now + 1000 }));
      queueMessage(db, "owner", { title: "second" }, now);
      vi.mocked(webpush.sendNotification).mockImplementationOnce(async () => {
        if (loss === "taken") db.prepare("UPDATE worker_state SET value=? WHERE key='lease'").run(JSON.stringify({ owner: "other", expires: now + 1000 }));
        else clock += 1000;
        return { statusCode: 201, body: "", headers: {} };
      });
      await deliverPush(db, () => clock, { hasLease: () => workerLeaseHeld(db, "worker", clock) });
      expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
      expect(db.prepare("SELECT SUM(done) AS n FROM deliveries").get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });
  it("does not dispatch at all without a live lease", async () => {
    const db = setup();
    try {
      await deliverPush(db, () => now, { hasLease: () => workerLeaseHeld(db, "missing", now) });
      expect(webpush.sendNotification).not.toHaveBeenCalled();
    } finally { db.close(); }
  });
  it.each(["delivery", "watch", "disabled", "topic", "condition", "owner", "subscription"])("reloads %s state after an earlier send", async change => {
    const db = setup();
    try {
      db.prepare("INSERT INTO installations VALUES('other',?)").run(now);
      db.prepare("INSERT INTO watches(id,owner,data) VALUES('watch','owner',?)").run(JSON.stringify(watch));
      queueMessage(db, "owner", { topicId: watch.topicId, event: { operator: watch.operator, threshold: watch.threshold } }, now, "watch");
      vi.mocked(webpush.sendNotification).mockImplementationOnce(async () => {
        if (change === "delivery") db.prepare("DELETE FROM deliveries WHERE outbox_id=2").run();
        if (change === "watch") db.prepare("DELETE FROM watches WHERE id='watch'").run();
        if (change === "disabled") db.prepare("UPDATE watches SET data=? WHERE id='watch'").run(JSON.stringify({ ...watch, enabled: false }));
        if (change === "topic") db.prepare("UPDATE watches SET data=? WHERE id='watch'").run(JSON.stringify({ ...watch, topicId: 999 }));
        if (change === "condition") db.prepare("UPDATE watches SET data=? WHERE id='watch'").run(JSON.stringify({ ...watch, threshold: 1000 }));
        if (change === "owner") db.prepare("UPDATE watches SET owner='other' WHERE id='watch'").run();
        if (change === "subscription") db.prepare("UPDATE subscriptions SET owner='other'").run();
        return { statusCode: 201, body: "", headers: {} };
      });
      await deliverPush(db, now);
      expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    } finally { db.close(); }
  });
  it("uses refreshed subscription credentials for the next send", async () => {
    const db = setup();
    try {
      queueMessage(db, "owner", { title: "second" }, now);
      const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/token", keys: { auth: "new-auth", p256dh: "new-key" } };
      vi.mocked(webpush.sendNotification).mockImplementationOnce(async () => {
        db.prepare("UPDATE subscriptions SET data=?").run(JSON.stringify(subscription));
        return { statusCode: 201, body: "", headers: {} };
      }).mockResolvedValueOnce({ statusCode: 201, body: "", headers: {} });
      await deliverPush(db, now);
      expect(webpush.sendNotification).toHaveBeenNthCalledWith(2, subscription, expect.any(String), expect.any(Object));
    } finally { db.close(); }
  });
  it.each(["stale", "target"])("rechecks %s expiry against the clock for each item", async expiry => {
    const db = setup(); let clock = now;
    try {
      queueMessage(db, "owner", { targetAt: new Date(now + 100000).toISOString() }, now);
      vi.mocked(webpush.sendNotification).mockImplementationOnce(async () => {
        clock += expiry === "stale" ? 301000 : 100000;
        return { statusCode: 201, body: "", headers: {} };
      });
      await deliverPush(db, () => clock);
      expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
      expect(db.prepare("SELECT SUM(done) AS n FROM deliveries").get()).toEqual({ n: 2 });
    } finally { db.close(); }
  });
  it("calculates TTL and retry time using the advancing clock", async () => {
    const db = setup(); let clock = now;
    try {
      queueMessage(db, "owner", { title: "second" }, now);
      vi.mocked(webpush.sendNotification).mockImplementationOnce(async () => {
        clock += 60000; return { statusCode: 201, body: "", headers: {} };
      }).mockImplementationOnce(async () => { clock += 10000; throw { statusCode: 500 }; });
      await deliverPush(db, () => clock);
      expect(webpush.sendNotification).toHaveBeenNthCalledWith(2, expect.any(Object), expect.any(String), expect.objectContaining({ TTL: 240 }));
      expect(db.prepare("SELECT next_ms FROM deliveries WHERE outbox_id=2").get()).toEqual({ next_ms: now + 100000 });
    } finally { db.close(); }
  });
  it.each([404, 410])("removes expired HTTP %s subscriptions", async statusCode => {
    const db = setup();
    try {
      vi.mocked(webpush.sendNotification).mockRejectedValue({ statusCode });
      await deliverPush(db, now);
      expect(db.prepare("SELECT COUNT(*) AS n FROM subscriptions").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM deliveries").get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });
  it("bounds retries to five attempts", async () => {
    const db = setup(); vi.stubEnv("STALE_SECONDS", "3600");
    try {
      vi.mocked(webpush.sendNotification).mockRejectedValue({ statusCode: 500 });
      for (const seconds of [0, 30, 90, 210, 450, 1000]) await deliverPush(db, now + seconds * 1000);
      expect(webpush.sendNotification).toHaveBeenCalledTimes(5);
      expect(db.prepare("SELECT attempts FROM deliveries").get()).toEqual({ attempts: 5 });
    } finally { db.close(); }
  });
  it("does not deliver stale or past-target notifications", async () => {
    const db = setup();
    try {
      await deliverPush(db, now + 301000);
      expect(webpush.sendNotification).not.toHaveBeenCalled();
      expect(db.prepare("SELECT done FROM deliveries").get()).toEqual({ done: 1 });
    } finally { db.close(); }
  });
});
