import { z } from "zod";
import type { DB } from "./db";
import { config } from "./config";
import { latestForecast, listMarkets } from "./store";
import type { TimelineResult } from "../lib/types";

export const timelineInputSchema = z.object({ cadence: z.enum(["hourly", "daily"]).optional(), limit: z.number().int().min(1).max(32).default(32) }).strict();

export function timeline(db: DB, input: z.input<typeof timelineInputSchema> = {}, now = Date.now()): TimelineResult {
  const options = timelineInputSchema.parse(input);
  return db.transaction(() => {
    const markets = listMarkets(db, now);
    const cadence = options.cadence ?? (markets.markets.some(m => m.cadence === "hourly") ? "hourly" : "daily");
    const seen = new Set<string>();
    const targets = markets.markets.filter(m => {
      if (m.cadence !== cadence || seen.has(m.targetAt)) return false;
      seen.add(m.targetAt); return true;
    }).slice(0, options.limit).map(m => {
      const result = latestForecast(db, m.topicId, now);
      return { ...result, ...(result.forecast ? { freshUntil: new Date(Date.parse(result.forecast.capturedAt) + config().STALE_SECONDS * 1000).toISOString() } : {}) };
    });
    return { cadence, asOf: new Date(now).toISOString(), collectedAt: markets.collectedAt, source: markets.source, targets };
  })();
}
