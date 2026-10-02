import type { Cadence, PriceObservation } from "../lib/types";
import type { DB } from "./db";

const intervals = { hourly: 60, daily: 1440 } as const;
// Kraken labels candles by their opening second, not their closing time.
export function parseCandles(payload: unknown, cadence: Cadence, now: number): { observation: PriceObservation; raw: unknown }[] {
  const body = payload as { error?: unknown; result?: Record<string, unknown> } | null;
  if (!body || !Array.isArray(body.error) || body.error.length || !body.result || typeof body.result !== "object") throw new Error("Invalid OHLC response");
  const keys = Object.keys(body.result).filter(key => key !== "last");
  if (keys.length !== 1 || !["XXBTZUSD", "XBTUSD", "BTCUSD"].includes(keys[0]) || !Array.isArray(body.result[keys[0]])) throw new Error("Wrong OHLC pair or schema");
  const interval = intervals[cadence], duration = interval * 60;
  const rows = body.result[keys[0]] as unknown[];
  // The response can include 720 historical rows plus the unfinished current candle.
  if (rows.length > 721) throw new Error("OHLC response exceeds provider history limit");
  const starts = new Set<number>();
  const candles = rows.flatMap<{ observation: PriceObservation; raw: unknown }>(raw => {
    if (!Array.isArray(raw) || raw.length !== 8 || !Number.isSafeInteger(raw[0]) || raw[0] < 1230768000 || raw[0] % duration !== 0 || typeof raw[4] !== "string" || raw[4].trim() === "") throw new Error("Invalid OHLC candle");
    const value = Number(raw[4]);
    if ([1, 2, 3, 5].some(i => typeof raw[i] !== "string" || !Number.isFinite(Number(raw[i])) || Number(raw[i]) <= 0) || typeof raw[6] !== "string" || !Number.isFinite(Number(raw[6])) || Number(raw[6]) < 0 || !Number.isSafeInteger(raw[7]) || raw[7] < 0 || starts.has(raw[0])) throw new Error("Invalid OHLC values or duplicate candle");
    starts.add(raw[0]);
    if (!Number.isFinite(value) || value <= 0 || raw[0] * 1000 > now + duration * 1000) throw new Error("Invalid OHLC close or time");
    const end = (raw[0] + duration) * 1000;
    if (end > now) return [];
    return [{ raw, observation: { source: "Kraken", pair: "XBTUSD", cadence, interval, value, candleStart: new Date(raw[0] * 1000).toISOString(), candleEnd: new Date(end).toISOString(), fetchedAt: new Date(now).toISOString() } }];
  });
  if (candles.length > 720) throw new Error("OHLC response exceeds closed history limit");
  return candles;
}

export function saveCandles(db: DB, candles: ReturnType<typeof parseCandles>) {
  db.transaction(() => {
    for (const { observation: o, raw } of candles) {
      const target = Date.parse(o.candleEnd);
      const serialized = JSON.stringify(raw);
      const previous = db.prepare("SELECT raw FROM provider_price_versions WHERE cadence=? AND target_ms=? ORDER BY captured_ms DESC LIMIT 1").get(o.cadence, target) as { raw: string } | undefined;
      if (previous?.raw !== serialized) db.prepare("INSERT OR IGNORE INTO provider_price_versions(cadence,target_ms,captured_ms,raw) VALUES(?,?,?,?)").run(o.cadence, target, Date.parse(o.fetchedAt), serialized);
      // First closed observation is immutable; provider revisions remain separate evidence.
      db.prepare("INSERT OR IGNORE INTO provider_prices(cadence,target_ms,value,data) VALUES(?,?,?,?)").run(o.cadence, target, o.value, JSON.stringify(o));
    }
  }).immediate();
}

export async function collectPrices(db: DB, signal: AbortSignal, hasLease: () => boolean, fetcher: typeof fetch = fetch, now = Date.now()) {
  for (const cadence of ["hourly", "daily"] as const) {
    if (signal.aborted || !hasLease()) return;
    const key = `prices-${cadence}`;
    const last = db.prepare("SELECT value FROM worker_state WHERE key=?").get(key) as { value: string } | undefined;
    const failures = db.prepare("SELECT value FROM worker_state WHERE key=?").get(`${key}-failures`) as { value: string } | undefined;
    const failureCount = failures ? Number(failures.value) : 0;
    if (last && now - Number(last.value) < 300000 * 2 ** Math.min(3, failureCount)) continue;
    db.prepare("INSERT INTO worker_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, String(now));
    // Two calls per paced cycle. Failed calls retry on the next cycle, not in a burst.
    try {
      const response = await fetcher(`https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=${intervals[cadence]}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]), cache: "no-store" });
      if (!response.ok) throw new Error(`OHLC HTTP ${response.status}`);
      const candles = parseCandles(await response.json(), cadence, now);
      if (!signal.aborted && hasLease()) {
        saveCandles(db, candles);
        db.prepare("DELETE FROM worker_state WHERE key=?").run(`${key}-failures`);
      }
    } catch (error) {
      if (!signal.aborted && hasLease()) {
        db.prepare("INSERT INTO worker_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`${key}-failures`, String(Math.min(3, failureCount + 1)));
        console.error(`Closed-price collection ${cadence}:`, error instanceof Error ? error.message : "failed");
      }
    }
  }
}
