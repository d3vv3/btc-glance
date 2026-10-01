import { z } from "zod";
import type { Cadence, Market } from "../lib/types";
export const BATCHES: Record<Cadence, string> = { daily: "4eb65bd2-5f0f-4071-b8b0-4a8127848d1d", hourly: "c6dd0be7-b9b8-4a8a-b735-623660c38982" };
export const marketSchema = z.object({ topic_id: z.number().int().positive(), batch_id: z.string(), title: z.string(), description: z.string().default(""), end_time_utc: z.number().int().positive(), num_outcomes: z.number().int().min(2), is_active: z.boolean(), is_resolved: z.boolean(), resolved_option_id: z.number().int().positive().optional(), volume_24h_millisats: z.number().finite().nonnegative().optional(), total_volume_millisats: z.number().finite().nonnegative().optional(), total_amount_in_market: z.number().finite().nonnegative().optional(), outcomes: z.array(z.object({ option_id: z.number().int().positive(), name: z.string() })) }).passthrough();
export const feedSchema = z.object({ markets: z.array(z.unknown()), has_more: z.boolean(), next_offset: z.number().int().nonnegative().nullable().optional() }).passthrough();
export function parseMarket(raw: unknown, cadence: Cadence): Market {
  const m = marketSchema.parse(raw);
  if (m.batch_id !== BATCHES[cadence]) throw new Error("Unexpected market batch");
  if (m.outcomes.length !== m.num_outcomes || new Set(m.outcomes.map(o => o.option_id)).size !== m.num_outcomes) throw new Error("Incomplete discovered outcome coverage");
  return { topicId: m.topic_id, batchId: m.batch_id, title: m.title, description: m.description, cadence, targetAt: new Date(m.end_time_utc * 1000).toISOString(), outcomeCount: m.num_outcomes, resolvedOptionId: m.is_resolved ? m.resolved_option_id ?? null : null, source: "live", volume24hMillisats: m.volume_24h_millisats ?? null, totalVolumeMillisats: m.total_volume_millisats ?? null, liquidityMillisats: m.total_amount_in_market ?? null };
}
export class GlimpseClient {
  private nextRequest = 0;
  constructor(private readonly signal?: AbortSignal) {}
  async get(path: string): Promise<unknown> {
    if (!path.startsWith("/api/v1/nmarket/")) throw new Error("Unsupported Glimpse path");
    for (let attempt = 0; attempt < 3; attempt++) {
      this.signal?.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, Math.max(0, this.nextRequest - Date.now())));
      this.nextRequest = Date.now() + 1100;
      try {
        const timeout = AbortSignal.timeout(15000);
        const response = await fetch(`https://main.bpmapi.io${path}`, { signal: this.signal ? AbortSignal.any([this.signal, timeout]) : timeout, redirect: "error", headers: { Accept: "application/json" } });
        if (!response.ok) {
          if ((response.status === 429 || response.status >= 500) && attempt < 2) {
            const retryHeader = Number(response.headers.get("retry-after"));
            this.nextRequest = Date.now() + Math.min(60000, Math.max(2000 * 2 ** attempt, Number.isFinite(retryHeader) ? retryHeader * 1000 : 0));
            await response.body?.cancel(); continue;
          }
          throw new Error(`Glimpse HTTP ${response.status}`);
        }
        // Bound response bytes independently of pagination claims from the upstream.
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Empty Glimpse response");
        const chunks: Uint8Array[] = []; let size = 0;
        for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 12 * 1024 * 1024) { await reader.cancel(); throw new Error("Glimpse response exceeds byte limit"); } chunks.push(value); }
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      } catch (error) {
        this.signal?.throwIfAborted();
        if (attempt === 2 || (error instanceof Error && error.message.startsWith("Glimpse HTTP 4"))) throw error;
        this.nextRequest = Math.max(this.nextRequest, Date.now() + 2000 * 2 ** attempt);
      }
    }
    throw new Error("Glimpse request exhausted");
  }
}
