import { randomUUID } from "node:crypto";
import { openDatabase, workerLeaseHeld } from "../src/server/db";
import { config } from "../src/server/config";
import { collect } from "../src/server/collector";
import { GlimpseClient } from "../src/server/glimpse";
import { deliverPush } from "../src/server/push";

const db = openDatabase();
const owner = randomUUID();
const controller = new AbortController();
let stopping = false;
const once = process.argv.includes("--once");
const lease = db.transaction(() => {
  const row = db.prepare("SELECT value FROM worker_state WHERE key='lease'").get() as { value: string } | undefined;
  const current = row ? JSON.parse(row.value) as { owner: string; expires: number } : null;
  if (current && current.expires > Date.now() && current.owner !== owner) return false;
  db.prepare("INSERT INTO worker_state(key,value) VALUES('lease',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ owner, expires: Date.now() + 120000 }));
  return true;
});
function hasLease() {
  return workerLeaseHeld(db, owner);
}
if (!lease.immediate()) { db.close(); throw new Error("Another worker holds this database lease"); }
const heartbeat = setInterval(() => {
  try { if (!lease.immediate()) { stopping = true; controller.abort(new Error("Worker lease lost")); } } catch (e) { stopping = true; controller.abort(e); }
}, 30000);
function stop() { stopping = true; controller.abort(); }
process.on("SIGINT", stop); process.on("SIGTERM", stop);
async function main() {
  try {
    do {
      const start = Date.now();
      try { await collect(db, new GlimpseClient(controller.signal), Date.now(), { signal: controller.signal, hasLease }); if (!stopping) await deliverPush(db, Date.now, { signal: controller.signal, hasLease }); } catch (error) { if (!stopping) { console.error(error); if (once) process.exitCode = 1; } }
      if (once || stopping) break;
      const delay = Math.max(1000, config().COLLECT_INTERVAL_SECONDS * 1000 - (Date.now() - start));
      await new Promise<void>(resolve => { const timer = setTimeout(done, delay); function done() { clearTimeout(timer); controller.signal.removeEventListener("abort", done); resolve(); } controller.signal.addEventListener("abort", done, { once: true }); });
    } while (!stopping);
  } finally {
    clearInterval(heartbeat);
    db.prepare("DELETE FROM worker_state WHERE key='lease' AND json_extract(value,'$.owner')=?").run(owner);
    db.close();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
