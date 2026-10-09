/** The rate-limit store contract and the per-process store (see rateLimit.ts for how limits are applied). */

export interface RateLimitStore {
  /** Count one hit for `key` in the current window; returns the new count and window end (ms epoch). */
  hit(key: string, windowMs: number, now?: number): Promise<{ count: number; resetAt: number }>;
  reset(key?: string): Promise<void>;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly maxKeys = 50_000) {}

  async hit(key: string, windowMs: number, now = Date.now()) {
    let w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      if (this.windows.size >= this.maxKeys) this.prune(now);
      w = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, w);
    }
    w.count += 1;
    return { count: w.count, resetAt: w.resetAt };
  }

  async reset(key?: string) {
    if (key) this.windows.delete(key);
    else this.windows.clear();
  }

  private prune(now: number) {
    for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
    // Still full (a flood of distinct keys): drop the oldest half rather than grow without bound.
    if (this.windows.size >= this.maxKeys) [...this.windows.keys()].slice(0, Math.floor(this.maxKeys / 2)).forEach((k) => this.windows.delete(k));
  }
}
