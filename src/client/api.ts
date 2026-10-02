import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "../server/router";
import { publicQueryCache, type QueryOptions } from "./query-cache";

const PUBLIC_TTL = 60_000;
const SNAPSHOT_TTL = 24 * 60 * 60_000;

function publicKey(path: string): { key: string; ttl: number } | null {
  const url = new URL(path, "http://public.local");
  if (url.origin !== "http://public.local" || !["/api/markets", "/api/forecasts", "/api/forecasts/timeline", "/api/forecasts/snapshot"].includes(url.pathname)) return null;
  if (url.pathname === "/api/forecasts/timeline") {
    if (!url.searchParams.has("limit")) url.searchParams.set("limit", "32");
    if (!url.searchParams.has("pastCount")) url.searchParams.set("pastCount", "3");
  }
  url.searchParams.sort();
  return { key: `http:${url.pathname}?${url.searchParams}`, ttl: url.pathname === "/api/forecasts/snapshot" ? SNAPSHOT_TTL : PUBLIC_TTL };
}

export function invalidatePublicReads(path?: string): void {
  if (path === undefined) publicQueryCache.invalidate();
  else { const query = publicKey(path); if (query) publicQueryCache.invalidate(query.key); }
}

export const api = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: "/api/trpc", fetch: (url, options) => fetch(url, { ...options, credentials: "same-origin", cache: "no-store" }) })],
});

export async function publicRead<T>(path: string, signal?: AbortSignal, options: QueryOptions = {}): Promise<{ data: T; cachedAt: string | null }> {
  const query = publicKey(path);
  const load = async () => {
    const response = await fetch(path, { cache: "no-store", ...(!query ? { signal: signal ?? options.signal } : {}) });
    if (!response.ok) throw new Error(`Public data unavailable (${response.status})`);
    return { data: await response.json() as T, cachedAt: response.headers.get("X-BW-Offline-Cached-At") };
  };
  return query ? publicQueryCache.query(query.key, query.ttl, load, { ...options, signal: signal ?? options.signal }) : load();
}

export function publicPerformance(options: QueryOptions = {}) {
  return publicQueryCache.query("trpc:forecasts.performance", PUBLIC_TTL, () => api.forecasts.performance.query(), options);
}

let pendingSession: Promise<void> | null = null;
export function establishSession(): Promise<void> {
  if (!pendingSession) {
    pendingSession = (async () => {
      const response = await fetch("/api/session", { method: "POST", credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("Could not establish this installation's session. Reconnect and try again.");
    })().finally(() => { pendingSession = null; });
  }
  return pendingSession;
}
