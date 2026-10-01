import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "../server/router";

export const api = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: "/api/trpc", fetch: (url, options) => fetch(url, { ...options, credentials: "same-origin", cache: "no-store" }) })],
});

export async function publicRead<T>(path: string, signal?: AbortSignal): Promise<{ data: T; cachedAt: string | null }> {
  const response = await fetch(path, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`Public data unavailable (${response.status})`);
  return { data: await response.json() as T, cachedAt: response.headers.get("X-BW-Offline-Cached-At") };
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
