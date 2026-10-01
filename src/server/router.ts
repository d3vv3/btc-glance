import { initTRPC, TRPCError, type inferRouterInputs, type inferRouterOutputs } from "@trpc/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DB } from "./db";
import { getDb } from "./db";
import { assertSameOrigin, rateLimit, sessionOwner, subscriptionSchema } from "./security";
import { latestForecast, listMarkets, performance, snapshotForecast } from "./store";
import { publicWatch, queueMessage, type WatchRow } from "./alerts";
import { pushConfig } from "./push";
import { config } from "./config";
import { timeline, timelineInputSchema } from "./timeline";
import { thresholdProbability } from "../lib/forecast";
import type { MutationResult, PushSubscriptionInput, Watch } from "../lib/types";

export interface Context { db: DB; request: Request; owner: string | null }
export function createContext(request: Request): Context { const db = getDb(); return { db, request, owner: sessionOwner(db, request) }; }
const t = initTRPC.context<Context>().create();
const publicProcedure = t.procedure;
const owned = publicProcedure.use(({ ctx, next }) => {
  if (!ctx.owner) throw new TRPCError({ code: "UNAUTHORIZED", message: "Create an installation via POST /api/session" });
  return next({ ctx: { ...ctx, owner: ctx.owner } });
});
const mutation = owned.use(({ ctx, next }) => { assertSameOrigin(ctx.request); rateLimit(ctx.db, `mutation:${ctx.owner}`); return next(); });
export const watchInputSchema = z.object({ topicId: z.number().int().positive(), operator: z.enum(["above", "below"]), threshold: z.number().finite().nonnegative(), materialPp: z.number().min(0.1).max(100).default(5), cooldownSeconds: z.number().int().min(60).max(604800).default(3600), enabled: z.boolean().default(true) });
const idSchema = z.object({ id: z.uuid() });
const ok = (): MutationResult => ({ ok: true });
function ownedWatch(ctx: Context, id: string): WatchRow {
  const row = ctx.db.prepare("SELECT * FROM watches WHERE id=? AND owner=?").get(id, ctx.owner) as WatchRow | undefined;
  if (!row) throw new TRPCError({ code: "NOT_FOUND" });
  return row;
}
function validateWatch(ctx: Context, input: z.infer<typeof watchInputSchema>) {
  const result = latestForecast(ctx.db, input.topicId);
  if (result.status !== "ready" || !result.forecast || result.forecast.source !== "live") throw new TRPCError({ code: "BAD_REQUEST", message: "Watch requires a fresh live forecast before target" });
  try { thresholdProbability(result.forecast.buckets, input.operator, input.threshold); } catch { throw new TRPCError({ code: "BAD_REQUEST", message: "Threshold must be a bucket boundary" }); }
}
export const appRouter = t.router({
  markets: t.router({ list: publicProcedure.query(({ ctx }) => listMarkets(ctx.db)) }),
  forecasts: t.router({ freshness: publicProcedure.query(() => ({ maxAgeSeconds: config().STALE_SECONDS })), latest: publicProcedure.input(z.object({ topicId: z.number().int().positive() })).query(({ ctx, input }) => {
    const maxAgeSeconds = config().STALE_SECONDS;
    const result = latestForecast(ctx.db, input.topicId);
    return { ...result, ...(result.forecast ? { freshUntil: new Date(Date.parse(result.forecast.capturedAt) + maxAgeSeconds * 1000).toISOString() } : {}) };
  }), timeline: publicProcedure.input(timelineInputSchema).query(({ ctx, input }) => timeline(ctx.db, input)), snapshot: publicProcedure.input(z.object({ snapshotId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })).query(({ ctx, input }) => snapshotForecast(ctx.db, input.snapshotId)), performance: publicProcedure.query(({ ctx }) => performance(ctx.db)) }),
  watches: t.router({
    list: owned.query(({ ctx }): Watch[] => (ctx.db.prepare("SELECT * FROM watches WHERE owner=? ORDER BY rowid DESC").all(ctx.owner) as WatchRow[]).map(publicWatch)),
    create: mutation.input(watchInputSchema).mutation(({ ctx, input }): Watch => {
      const id = randomUUID();
      ctx.db.transaction(() => {
        validateWatch(ctx, input);
        const count = ctx.db.prepare("SELECT COUNT(*) AS n FROM watches WHERE owner=?").get(ctx.owner) as { n: number };
        if (count.n >= 50) throw new TRPCError({ code: "BAD_REQUEST", message: "Maximum 50 watches" });
        ctx.db.prepare("INSERT INTO watches(id,owner,data) VALUES(?,?,?)").run(id, ctx.owner, JSON.stringify({ ...input, createdAt: new Date().toISOString() }));
      }).immediate();
      return publicWatch(ownedWatch(ctx, id));
    }),
    update: mutation.input(z.object({ id: z.uuid(), ...watchInputSchema.shape })).mutation(({ ctx, input }): Watch => {
      const { id, ...fields } = input;
      ctx.db.transaction(() => {
        const row = ownedWatch(ctx, input.id);
        const previous = JSON.parse(row.data) as Watch;
        const disableOnly = !fields.enabled && (["topicId", "operator", "threshold", "materialPp", "cooldownSeconds"] as const).every(key => fields[key] === previous[key]);
        if (!disableOnly) validateWatch(ctx, input);
        ctx.db.prepare("DELETE FROM outbox WHERE watch_id=?").run(id);
        ctx.db.prepare("UPDATE watches SET data=?,baseline=NULL,candidate_ms=NULL,candidate_direction=NULL,last_observed_ms=NULL,last_snapshot_id=NULL,notified_ms=NULL WHERE id=? AND owner=?").run(JSON.stringify({ ...fields, createdAt: (JSON.parse(row.data) as Watch).createdAt }), id, ctx.owner);
      }).immediate();
      return publicWatch(ownedWatch(ctx, id));
    }),
    delete: mutation.input(idSchema).mutation(({ ctx, input }) => {
      ctx.db.transaction(() => { ownedWatch(ctx, input.id); ctx.db.prepare("DELETE FROM watches WHERE id=? AND owner=?").run(input.id, ctx.owner); }).immediate();
      return ok();
    }),
  }),
  push: t.router({
    config: publicProcedure.query(() => pushConfig()),
    status: owned.input(z.object({ endpoint: subscriptionSchema.shape.endpoint }).strict()).query(({ ctx, input }): boolean => !!ctx.db.prepare("SELECT 1 FROM subscriptions WHERE endpoint=? AND owner=?").get(input.endpoint, ctx.owner)),
    register: mutation.input(subscriptionSchema).mutation(({ ctx, input }) => {
      if (!pushConfig().enabled) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "VAPID is not configured" });
      ctx.db.transaction(() => {
        const existing = ctx.db.prepare("SELECT owner FROM subscriptions WHERE endpoint=?").get(input.endpoint) as { owner: string } | undefined;
        if (existing && existing.owner !== ctx.owner) throw new TRPCError({ code: "CONFLICT", message: "Subscription already belongs to another installation" });
        const count = ctx.db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE owner=?").get(ctx.owner) as { n: number };
        if (!existing && count.n >= 5) throw new TRPCError({ code: "BAD_REQUEST", message: "Maximum 5 subscriptions" });
        ctx.db.prepare("INSERT INTO subscriptions(endpoint,owner,data) VALUES(?,?,?) ON CONFLICT(endpoint) DO UPDATE SET data=excluded.data").run(input.endpoint, ctx.owner, JSON.stringify(input satisfies PushSubscriptionInput));
      }).immediate(); return ok();
    }),
    unregister: mutation.input(z.object({ endpoint: z.string().max(2048) })).mutation(({ ctx, input }) => { ctx.db.prepare("DELETE FROM subscriptions WHERE endpoint=? AND owner=?").run(input.endpoint, ctx.owner); return ok(); }),
    test: mutation.mutation(({ ctx }) => {
      rateLimit(ctx.db, `push-test:${ctx.owner}`, 3);
      if (!pushConfig().enabled) throw new TRPCError({ code: "PRECONDITION_FAILED" });
      ctx.db.transaction(() => {
        if (!ctx.db.prepare("SELECT endpoint FROM subscriptions WHERE owner=?").get(ctx.owner)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Register a subscription first" });
        queueMessage(ctx.db, ctx.owner, { title: "Bitcoin Weather", body: "Test notification", url: "/", tag: `test-${randomUUID()}` }, Date.now());
      }).immediate(); return ok();
    }),
  }),
});
export type AppRouter = typeof appRouter;
export type RouterInputs = inferRouterInputs<AppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;
