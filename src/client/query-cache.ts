export interface QueryOptions { force?: boolean; signal?: AbortSignal }

interface Entry {
  value?: unknown;
  expiresAt: number;
  flight?: Promise<unknown>;
  forced?: boolean;
}

// Cancellation belongs to the caller, not the shared network request.
function forCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
    const cleanup = () => signal?.removeEventListener("abort", abort);
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(value => { cleanup(); if (!signal?.aborted) resolve(structuredClone(value)); }, error => { cleanup(); reject(error); });
  });
}

export class PublicQueryCache {
  private entries = new Map<string, Entry>();
  constructor(private readonly capacity = 128) {}

  invalidate(key?: string): void {
    if (key === undefined) this.entries.clear();
    else this.entries.delete(key);
  }

  query<T>(key: string, ttl: number, load: () => Promise<T>, options: QueryOptions = {}): Promise<T> {
    if (options.signal?.aborted) return forCaller(Promise.resolve(undefined as T), options.signal);
    let entry = this.entries.get(key);
    if (entry && (!options.force || entry.flight && entry.forced)) {
      this.entries.delete(key); this.entries.set(key, entry);
      if (entry.flight) return forCaller(entry.flight as Promise<T>, options.signal);
      if (entry.expiresAt > Date.now()) return forCaller(Promise.resolve(entry.value as T), options.signal);
    }
    // A forced request replaces an ordinary flight; only the current entry can publish.
    entry = { expiresAt: Date.now() + ttl, forced: !!options.force };
    const current = entry;
    this.entries.delete(key); this.entries.set(key, current);
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
    const flight = Promise.resolve().then(load).then(value => {
      const stored = structuredClone(value);
      if (this.entries.get(key) === current) { current.value = stored; current.flight = undefined; }
      return stored;
    }).catch(error => {
      if (this.entries.get(key) === current) this.entries.delete(key);
      throw error;
    });
    current.flight = flight;
    return forCaller(flight, options.signal);
  }
}

export const publicQueryCache = new PublicQueryCache();
