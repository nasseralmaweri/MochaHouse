// R1 / S3a — the per-process counter used when Redis cannot be reached, so a
// Redis outage degrades protection to "enforced per API instance" instead of
// switching it off. It mirrors the Redis semantics: a fixed window that starts
// at the first count and expires `windowSeconds` later.
//
// Memory is bounded: expired entries are dropped as the map grows, and if it
// is still full the oldest entry is evicted, so a flood of distinct keys can
// never exhaust the process.

interface Entry {
  count: number;
  expiresAt: number;
}

export const DEFAULT_MEMORY_MAX_KEYS = 20_000;

export class MemoryWindowCounter {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly maxKeys: number = DEFAULT_MEMORY_MAX_KEYS,
  ) {}

  // Counts one request (or only reads, when `increment` is false) and returns
  // the new count and the seconds until the window ends.
  hit(
    key: string,
    windowSeconds: number,
    increment: boolean,
  ): { count: number; retryAfterSeconds: number } {
    const nowMs = this.now();
    const existing = this.entries.get(key);

    if (existing && existing.expiresAt <= nowMs) {
      this.entries.delete(key);
    }
    const live = this.entries.get(key);

    if (!live) {
      if (!increment) return { count: 0, retryAfterSeconds: windowSeconds };
      this.makeRoom(nowMs);
      this.entries.set(key, {
        count: 1,
        expiresAt: nowMs + windowSeconds * 1000,
      });
      return { count: 1, retryAfterSeconds: windowSeconds };
    }

    if (increment) live.count += 1;
    return {
      count: live.count,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((live.expiresAt - nowMs) / 1000),
      ),
    };
  }

  get size(): number {
    return this.entries.size;
  }

  private makeRoom(nowMs: number): void {
    if (this.entries.size < this.maxKeys) return;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= nowMs) this.entries.delete(key);
    }
    while (this.entries.size >= this.maxKeys) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}
