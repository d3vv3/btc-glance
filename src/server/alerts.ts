import type { DB } from "./db";
import type { Forecast, Watch, WatchInput } from "../lib/types";
import { thresholdProbability } from "../lib/forecast";
import { config } from "./config";

export interface AlertState { baseline: number | null; candidateMs: number | null; candidateDirection: number | null; lastObservedMs: number | null; notifiedMs: number | null }
export interface AlertDecision { state: AlertState; notify: boolean; previous: number | null }
export function observeAlert(state: AlertState, probability: number, watch: WatchInput, capturedMs: number, targetMs: number, now: number, staleSeconds = 300): AlertDecision {
  const next = { ...state };
  const previous = state.baseline;
  if (!watch.enabled || now >= targetMs || capturedMs >= targetMs || capturedMs > now || now - capturedMs > staleSeconds * 1000 || !Number.isFinite(probability) || probability < 0 || probability > 1) return { state: { ...next, candidateMs: null, candidateDirection: null }, notify: false, previous };
  if (state.lastObservedMs !== null && capturedMs <= state.lastObservedMs) return { state: next, notify: false, previous };
  next.lastObservedMs = capturedMs;
  if (state.baseline === null) return { state: { ...next, baseline: probability, candidateMs: null, candidateDirection: null }, notify: false, previous };
  const delta = probability - state.baseline;
  const direction = Math.sign(delta);
  if (Math.abs(delta) * 100 + 1e-9 < watch.materialPp) return { state: { ...next, candidateMs: null, candidateDirection: null }, notify: false, previous };
  if (state.candidateMs === null || state.candidateDirection !== direction || (state.lastObservedMs !== null && capturedMs - state.lastObservedMs > staleSeconds * 1000)) return { state: { ...next, candidateMs: capturedMs, candidateDirection: direction }, notify: false, previous };
  if (capturedMs - state.candidateMs < 60000 || (state.notifiedMs !== null && now - state.notifiedMs < Math.max(60, watch.cooldownSeconds) * 1000)) return { state: next, notify: false, previous };
  return { state: { ...next, baseline: probability, candidateMs: null, candidateDirection: null, notifiedMs: now }, notify: true, previous };
}
export interface WatchRow { id: string; owner: string; data: string; baseline: number | null; candidate_ms: number | null; candidate_direction: number | null; last_observed_ms: number | null; last_snapshot_id: number | null; notified_ms: number | null }
export function publicWatch(row: WatchRow): Watch { return { ...JSON.parse(row.data) as WatchInput & { createdAt: string }, id: row.id, baseline: row.baseline, lastNotifiedAt: row.notified_ms === null ? null : new Date(row.notified_ms).toISOString() }; }
export function queueMessage(db: DB, owner: string, payload: object, now: number, watchId: string | null = null, snapshotId: number | null = null): boolean {
  return db.transaction(() => {
    const result = db.prepare("INSERT OR IGNORE INTO outbox(watch_id,snapshot_id,owner,payload,created_ms) VALUES(?,?,?,?,?)").run(watchId, snapshotId, owner, JSON.stringify(payload), now);
    if (!result.changes) return false;
    db.prepare("INSERT INTO deliveries(outbox_id,endpoint) SELECT ?,endpoint FROM subscriptions WHERE owner=?").run(Number(result.lastInsertRowid), owner);
    return true;
  }).immediate();
}
export function processAlerts(db: DB, forecast: Forecast, now = Date.now()) {
  if (forecast.source !== "live") return;
  db.transaction(() => {
    const rows = db.prepare("SELECT * FROM watches").all() as WatchRow[];
    for (const row of rows) {
      const watch = JSON.parse(row.data) as WatchInput;
      if (watch.topicId !== forecast.topicId || row.last_snapshot_id === forecast.snapshotId) continue;
      const probability = thresholdProbability(forecast.buckets, watch.operator, watch.threshold).probability;
      const decision = observeAlert({ baseline: row.baseline, candidateMs: row.candidate_ms, candidateDirection: row.candidate_direction, lastObservedMs: row.last_observed_ms, notifiedMs: row.notified_ms }, probability, watch, Date.parse(forecast.capturedAt), Date.parse(forecast.targetAt), now, config().STALE_SECONDS);
      const s = decision.state;
      if (decision.notify) queueMessage(db, row.owner, { title: "BTC glance", body: `Market quote share for closing ${watch.operator} $${watch.threshold}: ${((decision.previous ?? 0) * 100).toFixed(1)}% to ${(probability * 100).toFixed(1)}%. Target ${forecast.targetAt}.`, topicId: forecast.topicId, snapshotId: forecast.snapshotId, targetAt: forecast.targetAt, event: { operator: watch.operator, threshold: watch.threshold, previousProbability: decision.previous, probability }, url: `/?topicId=${forecast.topicId}&snapshotId=${forecast.snapshotId}`, tag: `watch-${row.id}-${forecast.snapshotId}` }, now, row.id, forecast.snapshotId);
      db.prepare("UPDATE watches SET baseline=?,candidate_ms=?,candidate_direction=?,last_observed_ms=?,last_snapshot_id=?,notified_ms=? WHERE id=?").run(s.baseline, s.candidateMs, s.candidateDirection, s.lastObservedMs, forecast.snapshotId, s.notifiedMs, row.id);
    }
  }).immediate();
}
export function clearCandidates(db: DB, topicId: number) {
  db.prepare("UPDATE watches SET candidate_ms=NULL,candidate_direction=NULL WHERE json_extract(data,'$.topicId')=?").run(topicId);
}
