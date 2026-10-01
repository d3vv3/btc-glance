import type { DB } from "./db";
import { config } from "./config";
import { BOUNDARY_CAVEAT, QUOTE_SCALE_CAVEAT, brier, convertQuotes, selectLeadSnapshot, summarize } from "../lib/forecast";
import type { Diagnostic, Forecast, ForecastResult, Market, MarketsResult, PerformanceResult } from "../lib/types";

export function saveMarket(db: DB, market: Market, definitions?: { option_id: number; name: string }[]) {
  db.transaction(() => {
    const existing = getMarket(db, market.topicId);
    if (existing && (existing.batchId !== market.batchId || existing.targetAt !== market.targetAt || existing.source !== market.source || existing.outcomeCount !== market.outcomeCount)) throw new Error("Persisted market identity changed");
    db.prepare(`INSERT INTO markets(topic_id,data,definitions,target_ms,source,winner) VALUES(?,?,?,?,?,?) ON CONFLICT(topic_id) DO UPDATE SET data=excluded.data,definitions=COALESCE(markets.definitions,excluded.definitions),winner=COALESCE(excluded.winner,markets.winner)`).run(market.topicId, JSON.stringify(market), definitions ? JSON.stringify(definitions) : null, Date.parse(market.targetAt), market.source, market.resolvedOptionId);
  }).immediate();
}
export function getMarket(db: DB, id: number): Market | null {
  const row = db.prepare("SELECT data,winner FROM markets WHERE topic_id=?").get(id) as { data: string; winner: number | null } | undefined;
  return row ? { ...JSON.parse(row.data) as Market, resolvedOptionId: row.winner } : null;
}
export function recordSnapshot(db: DB, market: Market, raw: unknown, capturedMs: number): Forecast | null {
  return db.transaction(() => {
    const converted = convertQuotes(raw, market.outcomeCount);
    const q = raw as Record<string, unknown>;
    const diagnostics = [...converted.diagnostics];
    if (!q || q.topic_id !== market.topicId || q.batch_id !== market.batchId || q.market_end_time_utc !== Date.parse(market.targetAt) / 1000) diagnostics.push({ code: "identity", message: "Quote identity/target differs from discovered market." });
    const definitionRow = db.prepare("SELECT definitions FROM markets WHERE topic_id=?").get(market.topicId) as { definitions: string | null };
    if (definitionRow.definitions && Array.isArray(q?.outcomes)) {
      const definitions = JSON.parse(definitionRow.definitions) as { option_id: number; name: string }[];
      const supplied = q.outcomes as { option_id?: number; name?: string }[];
      if (definitions.some(d => !supplied.some(o => o?.option_id === d.option_id && o?.name === d.name))) diagnostics.push({ code: "outcome-identity", message: "Quotes do not cover the originally discovered outcome IDs and labels." });
    }
    if (capturedMs >= Date.parse(market.targetAt)) diagnostics.push({ code: "post-target", message: "Snapshot retrieved at or after target; not a forecast." });
    const result = db.prepare("INSERT INTO snapshots(topic_id,captured_ms,raw,diagnostics,market_data) VALUES(?,?,?,?,?)").run(market.topicId, capturedMs, JSON.stringify(raw), JSON.stringify(diagnostics), JSON.stringify(market));
    if (diagnostics.length) return null;
    const forecast: Forecast = { snapshotId: Number(result.lastInsertRowid), topicId: market.topicId, targetAt: market.targetAt, capturedAt: new Date(capturedMs).toISOString(), source: market.source, transformationVersion: "quote-share-v2", originalYesSum: converted.originalYesSum, normalizationFactor: converted.normalizationFactor, normalized: Math.abs(converted.originalYesSum - 100) > 1e-9, interpretation: "quote-share-not-calibrated", caveat: `${QUOTE_SCALE_CAVEAT} ${BOUNDARY_CAVEAT}`, buckets: converted.buckets, summary: summarize(converted.buckets) };
    db.prepare("UPDATE snapshots SET forecast=? WHERE id=?").run(JSON.stringify(forecast), forecast.snapshotId);
    return forecast;
  }).immediate();
}
export function snapshotForecast(db: DB, snapshotId: number): ForecastResult {
  const row = db.prepare("SELECT s.id,s.forecast,s.raw,s.diagnostics,s.captured_ms,COALESCE(s.market_data,m.data) AS market_data FROM snapshots s JOIN markets m ON m.topic_id=s.topic_id WHERE s.id=?").get(snapshotId) as { id: number; forecast: string | null; raw: string; diagnostics: string; captured_ms: number; market_data: string } | undefined;
  if (!row) return { market: null, forecast: null, status: "unavailable", diagnostics: [] };
  // Historical evidence is not a current trading forecast; it does not age into another status.
  return { market: JSON.parse(row.market_data) as Market, forecast: row.forecast ? JSON.parse(row.forecast) as Forecast : null, status: row.forecast ? "ready" : "invalid", diagnostics: JSON.parse(row.diagnostics) as Diagnostic[], provenance: { snapshotId: row.id, capturedAt: new Date(row.captured_ms).toISOString(), raw: JSON.parse(row.raw) as unknown } };
}
export function latestForecast(db: DB, topicId: number, now = Date.now()): ForecastResult {
  const market = getMarket(db, topicId);
  if (!market) return { market: null, forecast: null, status: "unavailable", diagnostics: [] };
  const row = db.prepare("SELECT id,forecast,raw,diagnostics,captured_ms FROM snapshots WHERE topic_id=? AND captured_ms<? AND captured_ms<=? ORDER BY captured_ms DESC,id DESC LIMIT 1").get(topicId, Date.parse(market.targetAt), now) as { id: number; forecast: string | null; raw: string; diagnostics: string; captured_ms: number } | undefined;
  const forecast = row?.forecast ? JSON.parse(row.forecast) as Forecast : null;
  const status = Date.parse(market.targetAt) <= now ? "expired" : !row ? "unavailable" : !forecast ? "invalid" : now - row.captured_ms > config().STALE_SECONDS * 1000 ? "stale" : "ready";
  return { market, forecast, status, diagnostics: row ? JSON.parse(row.diagnostics) as Diagnostic[] : [], ...(row ? { provenance: { snapshotId: row.id, capturedAt: new Date(row.captured_ms).toISOString(), raw: JSON.parse(row.raw) as unknown } } : {}) };
}
export function listMarkets(db: DB, now = Date.now()): MarketsResult {
  const source = config().demo ? "demo" : "live";
  const rows = db.prepare("SELECT topic_id FROM markets WHERE target_ms>? AND source=? ORDER BY target_ms,topic_id").all(now, source) as { topic_id: number }[];
  const last = db.prepare("SELECT MAX(captured_ms) AS ms FROM snapshots JOIN markets ON markets.topic_id=snapshots.topic_id WHERE source=? AND captured_ms<=?").get(source, now) as { ms: number | null };
  return { markets: rows.map(r => getMarket(db, r.topic_id)!), source, collectedAt: last.ms ? new Date(last.ms).toISOString() : null };
}
export function performance(db: DB, now = Date.now()): PerformanceResult {
  const markets = (db.prepare("SELECT topic_id FROM markets WHERE source='live' AND target_ms<=? ORDER BY target_ms").all(now) as { topic_id: number }[]).map(r => getMarket(db, r.topic_id)!);
  const groups = ([{ cadence: "hourly" as const, leadSeconds: 3600 }, { cadence: "daily" as const, leadSeconds: 86400 }]).map(({ cadence, leadSeconds }) => {
    const maxSnapshotAgeSeconds = 300;
    let missingSnapshotCount = 0, pendingResolutionCount = 0;
    const samples = markets.filter(m => m.cadence === cadence).flatMap(m => {
      const rows = db.prepare("SELECT forecast FROM snapshots WHERE topic_id=? AND forecast IS NOT NULL AND captured_ms<=? AND captured_ms>=? ORDER BY captured_ms DESC,id DESC LIMIT 1").all(m.topicId, Date.parse(m.targetAt) - leadSeconds * 1000, Date.parse(m.targetAt) - (leadSeconds + maxSnapshotAgeSeconds) * 1000) as { forecast: string }[];
      const snapshot = selectLeadSnapshot(rows.map(r => JSON.parse(r.forecast) as Forecast), Date.parse(m.targetAt), leadSeconds, maxSnapshotAgeSeconds);
      if (!snapshot) { missingSnapshotCount++; return []; }
      if (m.resolvedOptionId === null) { pendingResolutionCount++; return []; }
      return [{ topicId: m.topicId, snapshotId: snapshot.snapshotId, targetAt: m.targetAt, capturedAt: snapshot.capturedAt, resolvedOptionId: m.resolvedOptionId, transformationVersion: snapshot.transformationVersion, brier: brier(snapshot.buckets, m.resolvedOptionId) }];
    });
    return { cadence, leadSeconds, maxSnapshotAgeSeconds, eligibleCount: markets.filter(m => m.cadence === cadence).length, sampleCount: samples.length, missingSnapshotCount, pendingResolutionCount, meanBrier: samples.length ? samples.reduce((s, x) => s + x.brier, 0) / samples.length : null, samples };
  });
  return { metric: "multiclass-brier-original-bins", convention: "sum((p-y)^2), lower is better", source: "live", groups };
}
