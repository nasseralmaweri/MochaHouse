// R1 / S3a — the per-process counter used when Redis cannot be reached, so a
// Redis outage degrades protection to "enforced per API instance" instead of
// switching it off. It mirrors the Redis semantics: a fixed window that starts
// at the first count and expires `windowSeconds` later.
//
// Memory is bounded: expired entries are dropped as the map grows. If it is
// still full of LIVE counters, a request for a NEW key is refused (counted as
// over its limit) instead of evicting a live counter — evicting would let a
// flood of throwaway keys reset real limits. Reaching that cap takes tens of
// thousands of distinct live keys inside one window.

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
      if (!this.makeRoom(nowMs)) {
        // Full of LIVE counters: refuse rather than evict one, because
        // evicting would let a flood of throwaway keys reset real limits.
        return {
          count: Number.MAX_SAFE_INTEGER,
          retryAfterSeconds: windowSeconds,
        };
      }
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

  // Gives one count back (never below zero).
  release(key: string): void {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > this.now() && entry.count > 0) {
      entry.count -= 1;
    }
  }

  get size(): number {
    return this.entries.size;
  }

  // Room for one more counter: true if there is space (after dropping expired
  // entries), false if the map is full of live counters.
  private makeRoom(nowMs: number): boolean {
    if (this.entries.size < this.maxKeys) return true;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= nowMs) this.entries.delete(key);
    }
    return this.entries.size < this.maxKeys;
  }
}
