import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertSameOrigin, createSession, rateLimit, SESSION_COOKIE, sessionOwner, subscriptionSchema, validPushEndpoint } from "../src/server/security";
import { openDatabase } from "../src/server/db";
import { appRouter, watchInputSchema } from "../src/server/router";
describe("installation and mutation validation", () => {
  beforeEach(() => { vi.stubEnv("APP_ORIGIN", "http://localhost:3000"); });
  afterEach(() => { vi.unstubAllEnvs(); });
  it.each(["https://fcm.googleapis.com/fcm/send/token", "https://updates.push.services.mozilla.com/wpush/v2/token", "https://web.push.apple.com/token"])('allows standard service %s', url => { expect(validPushEndpoint(url)).toBe(true); });
  it.each(["https://localhost/token", "https://127.0.0.1/token", "http://fcm.googleapis.com/token", "https://fcm.googleapis.com.evil.test/token", "https://user:pass@fcm.googleapis.com/token", "https://fcm.googleapis.com:444/token", "https://evil.push.services.mozilla.com/token", "https://push.apple.com.evil.test/token"])('rejects unsafe endpoint %s', url => { expect(validPushEndpoint(url)).toBe(false); });
  it("requires same origin, secure token possession and persistent rate limits", () => {
    const db = openDatabase(":memory:");
    try {
      expect(() => assertSameOrigin(new Request("http://localhost:3000", { headers: { origin: "https://evil.test" } }))).toThrow();
      expect(() => assertSameOrigin(new Request("http://localhost:3000"))).toThrow();
      const token = createSession(db);
      const request = new Request("http://localhost:3000", { headers: { cookie: `${SESSION_COOKIE}=${token}`, origin: "http://localhost:3000" } });
      expect(sessionOwner(db, request)).not.toBeNull(); expect(sessionOwner(db, new Request("http://localhost:3000"))).toBeNull();
      rateLimit(db, "test", 1, 1); expect(() => rateLimit(db, "test", 1, 2)).toThrow(); expect(() => rateLimit(db, "test", 1, 60001)).not.toThrow();
    } finally { db.close(); }
  });
  it("rejects unsupported watch and subscription inputs", () => {
    expect(watchInputSchema.safeParse({ topicId: 1, operator: "above", threshold: 1, cooldownSeconds: 59 }).success).toBe(false);
    expect(subscriptionSchema.safeParse({ endpoint: "https://fcm.googleapis.com/token", keys: { p256dh: "x", auth: "y" } }).success).toBe(false);
  });
  it("accepts only the configured origin and ignores spoofed proxy hosts", () => {
    vi.stubEnv("APP_ORIGIN", "http://localhost:3104");
    const request = (origin?: string, extra: Record<string, string> = {}) => new Request("http://localhost:3104/api/session", { headers: { ...(origin === undefined ? {} : { origin }), ...extra } });
    expect(() => assertSameOrigin(request("http://localhost:3104", { "sec-fetch-site": "same-origin" }))).not.toThrow();
    for (const origin of [undefined, "null", "http://localhost:3000", "http://localhost:3100", "http://127.0.0.1:3104", "https://localhost:3104", "http://localhost:3104/", "http://localhost.evil.test:3104"]) {
      expect(() => assertSameOrigin(request(origin, { host: "localhost:3104", "x-forwarded-host": "localhost:3104", "x-forwarded-proto": "http", forwarded: "host=localhost:3104;proto=http" }))).toThrow();
    }
    expect(() => assertSameOrigin(request("http://localhost:3104", { "sec-fetch-site": "cross-site" }))).toThrow();
    vi.stubEnv("APP_ORIGIN", "https://weather.example.com");
    expect(() => assertSameOrigin(request("https://weather.example.com", { host: "internal:3104", "x-forwarded-host": "evil.test" }))).not.toThrow();
    expect(() => assertSameOrigin(request("https://evil.test", { "x-forwarded-host": "evil.test" }))).toThrow();
  });
  it("rejects unowned watch access", async () => {
    const db = openDatabase(":memory:");
    try {
      const request = new Request("http://localhost:3000", { headers: { origin: "http://localhost:3000" } });
      const anonymous = appRouter.createCaller({ db, request, owner: null });
      await expect(anonymous.watches.list()).rejects.toThrow(/installation/);
      db.prepare("INSERT INTO installations VALUES('a',1),('b',1)").run();
      db.prepare("INSERT INTO watches(id,owner,data) VALUES(?, 'a', '{}')").run("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      const other = appRouter.createCaller({ db, request, owner: "b" });
      await expect(other.watches.delete({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })).rejects.toThrow();
      expect(db.prepare("SELECT COUNT(*) AS n FROM watches").get()).toEqual({ n: 1 });
    } finally { db.close(); }
  });
});
