import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb, openDatabase } from "../src/server/db";
import { appRouter } from "../src/server/router";
import { recordSnapshot, saveMarket } from "../src/server/store";
import { GET } from "../src/app/api/forecasts/snapshot/route";
import { market, now, quote, watch } from "./fixtures";
vi.mock("../src/server/db", async importOriginal => ({ ...await importOriginal<typeof import("../src/server/db")>(), getDb: vi.fn() }));
afterEach(() => vi.clearAllMocks());
describe("public snapshot API", () => {
  it("shares the tRPC and HTTP evidence contract without private watch information", async () => {
    const db = openDatabase(":memory:");
    try {
      vi.mocked(getDb).mockReturnValue(db);
      saveMarket(db, market); const forecast = recordSnapshot(db, market, quote(), now)!;
      db.prepare("INSERT INTO installations VALUES('private-owner',?)").run(now);
      db.prepare("INSERT INTO watches(id,owner,data) VALUES('private-watch','private-owner',?)").run(JSON.stringify(watch));
      const request = new Request(`http://localhost:3000/api/forecasts/snapshot?snapshotId=${forecast.snapshotId}`);
      const caller = appRouter.createCaller({ db, request, owner: null });
      const result = await caller.forecasts.snapshot({ snapshotId: forecast.snapshotId });
      const response = GET(request);
      expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual(result);
      expect(JSON.stringify(result)).not.toMatch(/private-owner|private-watch|baseline|cooldownSeconds/);
      expect(result.provenance?.raw).toEqual(quote());
      await expect(caller.forecasts.snapshot({ snapshotId: 0 })).rejects.toThrow();
    } finally { db.close(); }
  });
  it.each(["", "0", "-1", "1.5", "abc", "9007199254740992"])("rejects invalid snapshotId %s before opening the database", value => {
    const response = GET(new Request(`http://localhost:3000/api/forecasts/snapshot?snapshotId=${value}`));
    expect(response.status).toBe(400); expect(getDb).not.toHaveBeenCalled();
  });
});
