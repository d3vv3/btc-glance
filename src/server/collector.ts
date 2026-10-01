import { z } from "zod";
import type { DB } from "./db";
import { config } from "./config";
import { BATCHES, feedSchema, GlimpseClient, marketSchema, parseMarket } from "./glimpse";
import { getMarket, recordSnapshot, saveMarket } from "./store";
import { clearCandidates, processAlerts } from "./alerts";
import type { Cadence, Market } from "../lib/types";
import type { DeliveryControl } from "./push";

function state(db: DB, key: string): string | null { return (db.prepare("SELECT value FROM worker_state WHERE key=?").get(key) as { value: string } | undefined)?.value ?? null; }
function setState(db: DB, key: string, value: unknown) { db.prepare("INSERT INTO worker_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value)); }
function diagnostic(db: DB, phase: string, error: unknown) { const message = error instanceof Error ? error.message : String(error); setState(db, `error:${phase}`, { at: new Date().toISOString(), message }); console.error(`[${phase}] ${message}`); }
export async function collect(db: DB, client = new GlimpseClient(), now = Date.now(), control: DeliveryControl = {}) {
  const active = () => !control.signal?.aborted && (control.hasLease?.() ?? true);
  if (!active()) return;
  if (config().demo) { collectDemo(db, now); return; }
  for (const cadence of ["hourly", "daily"] as const) {
    const discovered = Number(state(db, `discovery:${cadence}`) ?? 0);
    if (now - discovered >= 3600000) {
      try {
        const candidates: Market[] = [];
        const definitions = new Map<number, { option_id: number; name: string }[]>();
        let offset = 0;
        for (let page = 0; page < 8; page++) {
          const raw = await client.get(`/api/v1/nmarket/v2/batches/${BATCHES[cadence]}/active-markets?limit=50&offset=${offset}`);
          if (!active()) return;
          setState(db, `raw:discovery:${cadence}:${page}`, raw);
          const feed = feedSchema.parse(raw);
          for (const item of feed.markets) {
            try { const parsed = marketSchema.parse(item); const m = parseMarket(item, cadence); if (parsed.is_active && !parsed.is_resolved && Date.parse(m.targetAt) > now) { candidates.push(m); definitions.set(m.topicId, parsed.outcomes); } } catch (e) { diagnostic(db, `market:${cadence}`, e); }
          }
          if (!feed.has_more) break;
          if (page === 7) diagnostic(db, `discovery-bound:${cadence}`, "Discovery truncated at eight pages; selected horizons may be incomplete");
          const next = feed.next_offset ?? offset + 50;
          if (next <= offset) throw new Error("Non-progressing pagination");
          offset = next;
        }
        const unique = [...new Map(candidates.map(m => [m.topicId, m])).values()].sort((a, b) => Date.parse(a.targetAt) - Date.parse(b.targetAt));
        for (const market of unique.slice(0, cadence === "hourly" ? 8 : 14)) saveMarket(db, market, definitions.get(market.topicId));
        setState(db, `discovery:${cadence}`, now);
      } catch (e) { if (!active()) return; diagnostic(db, `discovery:${cadence}`, e); }
    }
  }
  // Include persisted watches even when they fall outside the newly discovered horizon.
  const activeRows = db.prepare("SELECT topic_id FROM markets WHERE source='live' AND winner IS NULL AND target_ms>? ORDER BY target_ms,topic_id").all(now) as { topic_id: number }[];
  const activeMarkets = activeRows.map(r => getMarket(db, r.topic_id)!);
  const selected = new Map<number, Market>();
  for (const cadence of ["hourly", "daily"] as const) for (const market of activeMarkets.filter(m => m.cadence === cadence).slice(0, cadence === "hourly" ? 8 : 14)) selected.set(market.topicId, market);
  const watched = new Map<number, Market>();
  for (const row of db.prepare("SELECT data FROM watches WHERE json_extract(data,'$.enabled')=1").all() as { data: string }[]) { const m = getMarket(db, (JSON.parse(row.data) as { topicId: number }).topicId); if (m && m.source === "live" && Date.parse(m.targetAt) > now && m.resolvedOptionId === null && !selected.has(m.topicId)) watched.set(m.topicId, m); }
  // The 22 horizon targets have priority; rotate unique watch-only IDs after the
  // last attempted ID so restarts and watch deletion cannot pin the first page.
  const watchOnly = [...watched.values()].sort((a, b) => a.topicId - b.topicId);
  const cursor = Number(state(db, "watchCursor") ?? 0);
  const start = watchOnly.findIndex(m => m.topicId > cursor);
  const rotated = [...watchOnly.slice(start < 0 ? 0 : start), ...watchOnly.slice(0, start < 0 ? 0 : start)];
  for (const m of rotated.slice(0, 32 - selected.size)) selected.set(m.topicId, m);
  for (const market of selected.values()) {
    if (!active()) return;
    if (watched.has(market.topicId)) setState(db, "watchCursor", market.topicId);
    try {
      const raw = await client.get(`/api/v1/nmarket/markets/${market.topicId}/quotes`);
      if (!active()) return;
      const snapshot = recordSnapshot(db, market, raw, Date.now());
      if (snapshot) processAlerts(db, snapshot); else clearCandidates(db, market.topicId);
    } catch (e) { if (!active()) return; clearCandidates(db, market.topicId); diagnostic(db, `quote:${market.topicId}`, e); }
  }
  await pollResolutions(db, client, now, control);
  if (!active()) return;
  setState(db, "lastCollection", { at: new Date().toISOString(), source: "live" });
}

export async function pollResolutions(db: DB, client: GlimpseClient, now = Date.now(), control: DeliveryControl = {}) {
  const active = () => !control.signal?.aborted && (control.hasLease?.() ?? true);
  if (!active()) return;
  // Poll saved unresolved IDs, rotating by last checked time, regardless of feed age.
  const pending = db.prepare("SELECT topic_id FROM markets WHERE source='live' AND winner IS NULL AND target_ms<=? ORDER BY resolution_checked_ms,target_ms LIMIT 8").all(now) as { topic_id: number }[];
  for (const row of pending) {
    if (!active()) return;
    db.prepare("UPDATE markets SET resolution_checked_ms=? WHERE topic_id=?").run(now, row.topic_id);
    try {
      const raw = await client.get(`/api/v1/nmarket/markets/${row.topic_id}/quotes`);
      if (!active()) return;
      const market = getMarket(db, row.topic_id)!;
      recordSnapshot(db, market, raw, Date.now());
      const resolved = z.object({ topic_id: z.number(), batch_id: z.string(), market_end_time_utc: z.number(), is_resolved: z.boolean(), resolved_option_id: z.number().int().positive().optional() }).parse(raw);
      if (resolved.topic_id !== row.topic_id || resolved.batch_id !== market.batchId || resolved.market_end_time_utc * 1000 !== Date.parse(market.targetAt)) throw new Error("Resolution quote identity mismatch");
      if (resolved.is_resolved && resolved.resolved_option_id !== undefined) saveResolution(db, market, resolved.resolved_option_id, raw);
    } catch (e) { if (!active()) return; diagnostic(db, `resolution:${row.topic_id}`, e); }
  }
  // Quotes currently omit winners. Walk the entire resolved feed with a persistent
  // cursor, not just its recent first page; only previously recorded IDs are scored.
  for (const cadence of ["hourly", "daily"] as const) {
    const count = db.prepare("SELECT COUNT(*) AS n FROM markets WHERE source='live' AND winner IS NULL AND target_ms<=? AND json_extract(data,'$.cadence')=?").get(now, cadence) as { n: number };
    if (!count.n) continue;
    let offset = Number(state(db, `resolutionCursor:${cadence}`) ?? 0);
    try {
      for (let page = 0; page < 2; page++) {
        const raw = await client.get(`/api/v1/nmarket/v2/batches/${BATCHES[cadence]}/resolved-markets?limit=50&offset=${offset}`);
        if (!active()) return;
        const feed = feedSchema.parse(raw);
        for (const item of feed.markets) {
          try {
            const m = marketSchema.parse(item);
            const saved = getMarket(db, m.topic_id);
            if (saved && saved.source === "live" && saved.batchId === m.batch_id && Date.parse(saved.targetAt) === m.end_time_utc * 1000 && m.is_resolved && m.resolved_option_id !== undefined) saveResolution(db, saved, m.resolved_option_id, item);
          } catch (e) { diagnostic(db, `resolved-feed:${cadence}`, e); }
        }
        if (!feed.has_more) { offset = 0; break; }
        const next = feed.next_offset ?? offset + 50;
        if (next <= offset) throw new Error("Non-progressing resolution pagination");
        offset = next;
      }
      setState(db, `resolutionCursor:${cadence}`, offset);
    } catch (e) { if (!active()) return; diagnostic(db, `resolved-feed:${cadence}`, e); }
  }
}
function saveResolution(db: DB, market: Market, winner: number, raw: unknown) {
  db.transaction(() => {
    if (Date.parse(market.targetAt) > Date.now()) throw new Error("Premature resolution");
    const rows = db.prepare("SELECT forecast FROM snapshots WHERE topic_id=? AND forecast IS NOT NULL ORDER BY id LIMIT 1").get(market.topicId) as { forecast: string } | undefined;
    const stored = db.prepare("SELECT definitions FROM markets WHERE topic_id=?").get(market.topicId) as { definitions: string | null };
    const knownWinner = stored.definitions ? (JSON.parse(stored.definitions) as { option_id: number }[]).some(o => o.option_id === winner) : Boolean(rows && (JSON.parse(rows.forecast) as { buckets: { optionId: number }[] }).buckets.some(b => b.optionId === winner));
    if (!knownWinner) { diagnostic(db, `winner:${market.topicId}`, "Winner cannot be matched to original recorded bins"); return; }
    const current = getMarket(db, market.topicId)!;
    if (current.resolvedOptionId !== null && current.resolvedOptionId !== winner) throw new Error("Conflicting resolution");
    db.prepare("UPDATE markets SET winner=? WHERE topic_id=?").run(winner, market.topicId); setState(db, `raw:resolution:${market.topicId}`, raw);
  }).immediate();
}
export function collectDemo(db: DB, now: number) {
  for (const cadence of ["hourly", "daily"] as Cadence[]) {
    const step = cadence === "hourly" ? 3600000 : 86400000;
    const target = Math.ceil((now + 1) / step) * step;
    const topicId = 900000000 + Math.floor(target / 1000) + (cadence === "daily" ? 100000000 : 0);
    const market: Market = { topicId, batchId: `demo-${cadence}`, cadence, title: `DEMO ONLY - illustrative ${cadence} Bitcoin quotes`, description: "Invented fixture, excluded from live scoring and notifications", targetAt: new Date(target).toISOString(), outcomeCount: 3, resolvedOptionId: null, source: "demo", volume24hMillisats: null, totalVolumeMillisats: null, liquidityMillisats: null };
    saveMarket(db, market);
    recordSnapshot(db, market, { topic_id: topicId, batch_id: market.batchId, title: market.title, market_end_time_utc: target / 1000, is_resolved: false, outcomes: [20, 60, 20].map((yes, i) => ({ option_id: i + 1, name: `${80000 + i * 1000}-${81000 + i * 1000}`, yes_price: yes, no_price: 100 - yes })) }, now);
  }
}
