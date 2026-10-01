import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type DB } from "../src/server/db";
import { SESSION_COOKIE } from "../src/server/security";
import { GET as trpcGET } from "../src/app/api/trpc/[trpc]/route";
import { POST } from "../src/app/api/session/route";

let db: DB;
const state = globalThis as typeof globalThis & { weatherDb?: DB };
beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", "http://localhost:3104");
  db = openDatabase(":memory:");
  state.weatherDb = db;
});
afterEach(() => { delete state.weatherDb; db.close(); vi.unstubAllEnvs(); });
const request = (origin = "http://localhost:3104", cookie?: string) => new Request("http://localhost:3104/api/session", { method: "POST", headers: { origin, "sec-fetch-site": "same-origin", ...(cookie ? { cookie } : {}) } });

describe("session HTTP routes", () => {
  it.each(["http://localhost:3104", "https://weather.example.com"])("issues a secure host-only cookie and authenticates watches at %s", async origin => {
    vi.stubEnv("APP_ORIGIN", origin);
    const response = POST(request(origin));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const header = response.headers.get("set-cookie")!;
    expect(header).toMatch(new RegExp(`^${SESSION_COOKIE}=[a-f0-9]{64};`));
    for (const attribute of ["Path=/", "Secure", "HttpOnly", "SameSite=strict", "Max-Age=31536000"]) expect(header).toContain(attribute);
    expect(header).not.toMatch(/Domain=/i);
    const cookie = header.split(";")[0];
    const watches = await trpcGET(new Request(`${origin}/api/trpc/watches.list`, { headers: { cookie } }));
    expect(watches.status).toBe(200);
    expect(await watches.json()).toEqual({ result: { data: [] } });
    expect(POST(request(origin, cookie)).headers.get("set-cookie")).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM installations").get()).toEqual({ n: 1 });
    expect((await trpcGET(new Request(`${origin}/api/trpc/watches.list`))).status).toBe(401);
  });
  it("rejects mismatched origins before issuing sessions and enforces the session rate limit", () => {
    expect(POST(request("http://localhost:3100")).status).toBe(403);
    expect(db.prepare("SELECT COUNT(*) AS n FROM installations").get()).toEqual({ n: 0 });
    db.prepare("INSERT INTO rate_limits VALUES('session-global',?,60)").run(Date.now());
    const response = POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
