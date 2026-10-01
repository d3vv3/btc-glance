import { createHash, randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { DB } from "./db";
import { config } from "./config";
export const SESSION_COOKIE = "__Host-bw_installation";
export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  // Authorization uses only the configured browser origin, never Host/Forwarded.
  if (origin !== config().APP_ORIGIN || request.headers.get("sec-fetch-site") === "cross-site") throw new TRPCError({ code: "FORBIDDEN", message: "Same-origin request required" });
}
export function rateLimit(db: DB, key: string, limit = 30, now = Date.now()) {
  db.transaction(() => {
    const r = db.prepare("SELECT start_ms,count FROM rate_limits WHERE key=?").get(key) as { start_ms: number; count: number } | undefined;
    if (r && now - r.start_ms < 60000 && r.count >= limit) throw new TRPCError({ code: "TOO_MANY_REQUESTS" });
    db.prepare("INSERT INTO rate_limits(key,start_ms,count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET start_ms=excluded.start_ms,count=?").run(key, r && now - r.start_ms < 60000 ? r.start_ms : now, r && now - r.start_ms < 60000 ? r.count + 1 : 1);
    db.prepare("DELETE FROM rate_limits WHERE start_ms<?").run(now - 3600000);
  }).immediate();
}
export function sessionOwner(db: DB, request: Request): string | null {
  const token = request.headers.get("cookie")?.split(";").map(s => s.trim()).find(s => s.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const owner = createHash("sha256").update(token).digest("hex");
  return db.prepare("SELECT id FROM installations WHERE id=?").get(owner) ? owner : null;
}
export function createSession(db: DB): string {
  const token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO installations(id,created_ms) VALUES(?,?)").run(createHash("sha256").update(token).digest("hex"), Date.now());
  return token;
}
export function validPushEndpoint(value: string): boolean {
  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase();
    const allowed = host === "fcm.googleapis.com" || host === "android.googleapis.com" || host === "updates.push.services.mozilla.com" || host === "web.push.apple.com";
    return allowed && u.protocol === "https:" && !u.username && !u.password && (!u.port || u.port === "443") && !u.hash && u.pathname.length > 1;
  } catch { return false; }
}
export const subscriptionSchema = z.object({ endpoint: z.string().max(2048).refine(validPushEndpoint, "Unsupported push service endpoint"), keys: z.object({ p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/), auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/) }) });
