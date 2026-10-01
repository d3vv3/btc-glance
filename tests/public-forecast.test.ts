import { afterEach, expect, it, vi } from "vitest";
import { getDb, openDatabase } from "../src/server/db";
import { recordSnapshot, saveMarket } from "../src/server/store";
import { GET } from "../src/app/api/forecasts/route";
import { market, now, quote } from "./fixtures";

vi.mock("../src/server/db", async original => ({ ...await original<typeof import("../src/server/db")>(), getDb: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

it("returns the configured validated deadline in the public forecast response", async () => {
  vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv("STALE_SECONDS", "90");
  const db = openDatabase(":memory:");
  try {
    vi.mocked(getDb).mockReturnValue(db);
    saveMarket(db, market); recordSnapshot(db, market, quote(), now);
    const response = GET(new Request(`http://localhost:3000/api/forecasts?topicId=${market.topicId}`));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ status: "ready", freshUntil: new Date(now + 90000).toISOString() });
    vi.setSystemTime(now + 90001);
    expect(await GET(new Request(`http://localhost:3000/api/forecasts?topicId=${market.topicId}`)).json()).toMatchObject({ status: "stale", freshUntil: new Date(now + 90000).toISOString() });
    recordSnapshot(db, market, quote([20, -1, 20]), now + 90001);
    const invalid = await GET(new Request(`http://localhost:3000/api/forecasts?topicId=${market.topicId}`)).json();
    expect(invalid.status).toBe("invalid"); expect(invalid.forecast).toBeNull(); expect(invalid).not.toHaveProperty("freshUntil");
  } finally { db.close(); }
});
