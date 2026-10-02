import { z } from "zod";
import type { DB } from "./db";
import { config } from "./config";
import { getMarket, latestForecast, listMarkets, snapshotForecast } from "./store";
import type { PriceObservation, TimelineResult, TimelineTarget } from "../lib/types";

export const timelineInputSchema = z.object({ cadence: z.enum(["hourly", "daily"]).optional(), limit: z.number().int().min(1).max(32).default(32), pastCount: z.number().int().min(0).max(7).default(3) }).strict();

export function timeline(db: DB, input: z.input<typeof timelineInputSchema> = {}, now = Date.now()): TimelineResult {
  const options = timelineInputSchema.parse(input);
  return db.transaction(() => {
    const markets = listMarkets(db, now);
    const cadence = options.cadence ?? (markets.markets.some(m => m.cadence === "hourly") ? "hourly" : "daily");
    const seen = new Set<string>();
    const targets: TimelineTarget[] = markets.markets.filter(m => {
      if (m.cadence !== cadence || seen.has(m.targetAt)) return false;
      seen.add(m.targetAt); return true;
    }).slice(0, options.limit).map(m => {
      const result = latestForecast(db, m.topicId, now);
      return { ...result, kind: "future", targetAt: m.targetAt, ...(result.forecast ? { freshUntil: new Date(Date.parse(result.forecast.capturedAt) + config().STALE_SECONDS * 1000).toISOString() } : {}) };
    });
    const step = cadence === "hourly" ? 3600000 : 86400000;
    const lastClosed = Math.floor(now / step) * step;
    const past: TimelineTarget[] = Array.from({ length: options.pastCount }, (_, i) => {
      const target = lastClosed - (options.pastCount - i - 1) * step;
      const targetAt = new Date(target).toISOString();
      const cutoff = target - 60000;
      const maxSnapshotAgeSeconds = cadence === "hourly" ? 14400 : 172800;
      const candidates = db.prepare("SELECT topic_id FROM markets WHERE target_ms=? AND source=? ORDER BY topic_id").all(target, markets.source) as { topic_id: number }[];
      const market = candidates.map(row => getMarket(db, row.topic_id)!).find(m => m.cadence === cadence) ?? null;
      // Visual history uses the last valid evidence, independently of fixed-lead scoring.
      const snapshot = market ? db.prepare("SELECT id,captured_ms FROM snapshots WHERE topic_id=? AND forecast IS NOT NULL AND captured_ms<=? AND captured_ms>=? ORDER BY captured_ms DESC,id DESC LIMIT 1").get(market.topicId, cutoff, target - maxSnapshotAgeSeconds * 1000) as { id: number; captured_ms: number } | undefined : undefined;
      const price = markets.source === "live" ? db.prepare("SELECT data FROM provider_prices WHERE cadence=? AND target_ms=?").get(cadence, target) as { data: string } | undefined : undefined;
      return { ...(snapshot ? snapshotForecast(db, snapshot.id) : { market, forecast: null, status: "unavailable" as const, diagnostics: [] }), kind: "past", targetAt, ...(price ? { observed: JSON.parse(price.data) as PriceObservation } : {}), ...(snapshot ? { archive: { policy: "latest-valid-pre-target" as const, snapshotId: snapshot.id, capturedAt: new Date(snapshot.captured_ms).toISOString(), leadSeconds: (target - snapshot.captured_ms) / 1000, maxSnapshotAgeSeconds, cutoff: new Date(cutoff).toISOString() } } : {}) };
    });
    return { cadence, asOf: new Date(now).toISOString(), collectedAt: markets.collectedAt, source: markets.source, targets: [...past, ...targets] };
  })();
}
