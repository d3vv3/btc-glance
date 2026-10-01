import webpush from "web-push";
import type { DB } from "./db";
import type { PushConfig, PushSubscriptionInput, WatchInput } from "../lib/types";
import { config } from "./config";
import { validPushEndpoint } from "./security";
export function pushConfig(): PushConfig {
  const c = config();
  return { enabled: Boolean(c.VAPID_PUBLIC_KEY && c.VAPID_PRIVATE_KEY), publicKey: c.VAPID_PUBLIC_KEY || null };
}
export interface DeliveryControl { signal?: AbortSignal; hasLease?: () => boolean }
export async function deliverPush(db: DB, clock: number | (() => number) = Date.now, control: DeliveryControl = {}) {
  const now = typeof clock === "number" ? () => clock : clock;
  const active = () => !control.signal?.aborted && (control.hasLease?.() ?? true);
  const c = config();
  if (!c.VAPID_PUBLIC_KEY || !c.VAPID_PRIVATE_KEY) return;
  webpush.setVapidDetails(c.VAPID_SUBJECT, c.VAPID_PUBLIC_KEY, c.VAPID_PRIVATE_KEY);
  if (!active()) return;
  // Only identities are cached across awaits. Cancellation and ownership are rechecked at dispatch.
  const rows = db.prepare(`SELECT outbox_id,endpoint FROM deliveries WHERE done=0 AND attempts<5 AND next_ms<=? ORDER BY outbox_id LIMIT 20`).all(now()) as { outbox_id: number; endpoint: string }[];
  for (const identity of rows) {
    if (!active()) return;
    const itemNow = now();
    const row = db.prepare(`SELECT d.outbox_id,d.endpoint,d.attempts,s.data,o.payload,o.created_ms,o.watch_id,w.data AS watch_data
      FROM deliveries d JOIN subscriptions s ON s.endpoint=d.endpoint JOIN outbox o ON o.id=d.outbox_id
      LEFT JOIN watches w ON w.id=o.watch_id
      WHERE d.outbox_id=? AND d.endpoint=? AND d.done=0 AND d.attempts<5 AND d.next_ms<=?
      AND s.owner=o.owner AND (o.watch_id IS NULL OR (w.owner=o.owner AND json_extract(w.data,'$.enabled')=1
        AND json_extract(w.data,'$.topicId')=json_extract(o.payload,'$.topicId')))`)
      .get(identity.outbox_id, identity.endpoint, itemNow) as { outbox_id: number; endpoint: string; attempts: number; data: string; payload: string; created_ms: number; watch_id: string | null; watch_data: string | null } | undefined;
    if (!row) continue;
    const payload = JSON.parse(row.payload) as { targetAt?: string; event?: { operator: string; threshold: number } };
    if (row.watch_data && payload.event) {
      const watch = JSON.parse(row.watch_data) as WatchInput;
      if (watch.operator !== payload.event.operator || watch.threshold !== payload.event.threshold) continue;
    }
    if (!validPushEndpoint(row.endpoint) || itemNow - row.created_ms >= c.STALE_SECONDS * 1000 || (payload.targetAt && Date.parse(payload.targetAt) <= itemNow)) { db.prepare("UPDATE deliveries SET done=1 WHERE outbox_id=? AND endpoint=?").run(row.outbox_id, row.endpoint); continue; }
    try {
      const expiresAt = Math.min(row.created_ms + c.STALE_SECONDS * 1000, payload.targetAt ? Date.parse(payload.targetAt) : Infinity);
      if (!active()) return;
      await webpush.sendNotification(JSON.parse(row.data) as PushSubscriptionInput, row.payload, { TTL: Math.max(1, Math.min(300, Math.floor((expiresAt - itemNow) / 1000))), timeout: 10000 });
      if (!active()) return;
      db.prepare("UPDATE deliveries SET done=1 WHERE outbox_id=? AND endpoint=?").run(row.outbox_id, row.endpoint);
    } catch (error) {
      if (!active()) return;
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) db.prepare("DELETE FROM subscriptions WHERE endpoint=? AND data=?").run(row.endpoint, row.data);
      else db.prepare("UPDATE deliveries SET attempts=attempts+1,next_ms=? WHERE outbox_id=? AND endpoint=? AND done=0").run(now() + Math.min(3600, 30 * 2 ** row.attempts) * 1000, row.outbox_id, row.endpoint);
    }
  }
}
