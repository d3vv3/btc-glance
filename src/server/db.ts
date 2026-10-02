import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "./config";
export type DB = Database.Database;
export function openDatabase(filename?: string): DB {
  if (!filename) { mkdirSync(config().DATA_DIR, { recursive: true, mode: 0o700 }); filename = path.join(config().DATA_DIR, "weather.sqlite"); }
  const db = new Database(filename);
  db.pragma("journal_mode = WAL"); db.pragma("foreign_keys = ON"); db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS markets (topic_id INTEGER PRIMARY KEY, data TEXT NOT NULL, definitions TEXT, target_ms INTEGER NOT NULL, source TEXT NOT NULL, winner INTEGER, resolution_checked_ms INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY, topic_id INTEGER NOT NULL REFERENCES markets(topic_id), captured_ms INTEGER NOT NULL, raw TEXT NOT NULL, forecast TEXT, diagnostics TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS snapshots_topic_time ON snapshots(topic_id,captured_ms);
    CREATE TABLE IF NOT EXISTS installations (id TEXT PRIMARY KEY, created_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS watches (id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES installations(id), data TEXT NOT NULL, baseline REAL, candidate_ms INTEGER, candidate_direction INTEGER, last_observed_ms INTEGER, last_snapshot_id INTEGER, notified_ms INTEGER);
    CREATE INDEX IF NOT EXISTS watches_owner ON watches(owner);
    CREATE TABLE IF NOT EXISTS subscriptions (endpoint TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES installations(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, watch_id TEXT REFERENCES watches(id) ON DELETE CASCADE, snapshot_id INTEGER REFERENCES snapshots(id), owner TEXT NOT NULL, payload TEXT NOT NULL, created_ms INTEGER NOT NULL, UNIQUE(watch_id,snapshot_id));
    CREATE TABLE IF NOT EXISTS deliveries (outbox_id INTEGER NOT NULL REFERENCES outbox(id) ON DELETE CASCADE, endpoint TEXT NOT NULL REFERENCES subscriptions(endpoint) ON DELETE CASCADE, attempts INTEGER NOT NULL DEFAULT 0, next_ms INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(outbox_id,endpoint));
    CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, start_ms INTEGER NOT NULL, count INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS worker_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS provider_prices (cadence TEXT NOT NULL, target_ms INTEGER NOT NULL, value REAL NOT NULL, data TEXT NOT NULL, PRIMARY KEY(cadence,target_ms));
    CREATE TABLE IF NOT EXISTS provider_price_versions (cadence TEXT NOT NULL, target_ms INTEGER NOT NULL, captured_ms INTEGER NOT NULL, raw TEXT NOT NULL, PRIMARY KEY(cadence,target_ms,captured_ms));
  `);
  const columns = db.pragma("table_info(snapshots)") as { name: string }[];
  if (!columns.some(column => column.name === "market_data")) {
    db.transaction(() => {
      // Recheck after acquiring the write lock: web and worker may start together.
      const current = db.pragma("table_info(snapshots)") as { name: string }[];
      if (!current.some(column => column.name === "market_data")) db.exec("ALTER TABLE snapshots ADD COLUMN market_data TEXT");
      // Legacy rows lack original market metadata; freeze the best available metadata on migration.
      db.exec("UPDATE snapshots SET market_data=(SELECT data FROM markets WHERE topic_id=snapshots.topic_id) WHERE market_data IS NULL");
    }).immediate();
  }
  return db;
}
export function workerLeaseHeld(db: DB, owner: string, now = Date.now()): boolean {
  const row = db.prepare("SELECT value FROM worker_state WHERE key='lease'").get() as { value: string } | undefined;
  const current = row ? JSON.parse(row.value) as { owner: string; expires: number } : null;
  return Boolean(current && current.owner === owner && current.expires > now);
}
const globalDb = globalThis as typeof globalThis & { weatherDb?: DB };
export function getDb(): DB { return globalDb.weatherDb ??= openDatabase(); }
