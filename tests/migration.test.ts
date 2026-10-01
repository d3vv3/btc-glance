import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { openDatabase } from "../src/server/db";
import { recordSnapshot, saveMarket, snapshotForecast } from "../src/server/store";
import { market, now, quote } from "./fixtures";

it("migrates legacy snapshots once and freezes their available market metadata", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "weather-migration-"));
  const filename = path.join(directory, "test.sqlite");
  let db = openDatabase(filename);
  try {
    saveMarket(db, market); const forecast = recordSnapshot(db, market, quote(), now)!;
    db.exec("ALTER TABLE snapshots DROP COLUMN market_data"); db.close();
    db = openDatabase(filename);
    const evidence = snapshotForecast(db, forecast.snapshotId);
    expect(evidence.market).toEqual(market); expect(evidence.provenance?.raw).toEqual(quote());
    saveMarket(db, { ...market, title: "New title", resolvedOptionId: 2 });
    db.close(); db = openDatabase(filename);
    expect(snapshotForecast(db, forecast.snapshotId)).toEqual(evidence);
  } finally { if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); }
});
