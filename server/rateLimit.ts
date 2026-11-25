import type express from 'express';

interface Bucket {
  tokens: number;
  last: number;
}

/** In-memory token bucket per key (client IP), like nginx's limit_req with burst + nodelay. */
export class TokenBuckets {
  private buckets = new Map<string, Bucket>();

  constructor(
    private ratePerSec: number,
    private burst: number,
    private now: () => number = Date.now,
  ) {}

  private refill(key: string): Bucket {
    const now = this.now();
    const b = this.buckets.get(key);
    if (!b) {
      const fresh = { tokens: this.burst, last: now };
      this.buckets.set(key, fresh);
      return fresh;
    }
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.last) / 1000) * this.ratePerSec);
    b.last = now;
    return b;
  }

  /** True if a token is available, without taking it */
  has(key: string): boolean {
    return this.refill(key).tokens >= 1;
  }

  /** Takes a token; false if none left */
  take(key: string): boolean {
    const b = this.refill(key);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Drops buckets that have refilled completely (same as never seen) */
  sweep() {
    for (const key of [...this.buckets.keys()]) {
      if (this.refill(key).tokens >= this.burst) this.buckets.delete(key);
    }
  }

  get size() {
    return this.buckets.size;
  }
}

export const clientKey = (req: express.Request) => req.socket.remoteAddress ?? 'unknown';

export function tooManyRequests(res: express.Response) {
  res.set('Retry-After', '1');
  res.status(429).json({ error: 'Too many requests' });
}

export function rateLimit(buckets: TokenBuckets): express.RequestHandler {
  return (req, res, next) => (buckets.take(clientKey(req)) ? next() : tooManyRequests(res));
}

/**
 * Wrong logins per client: MAX_FAILURES within WINDOW blocks that client for BLOCK.
 * Bounded, so a flood of addresses can't grow it without limit.
 */
export class LoginLimiter {
  static readonly MAX_FAILURES = 5;
  static readonly WINDOW_MS = 15 * 60_000;
  static readonly BLOCK_MS = 15 * 60_000;
  private static readonly MAX_TRACKED = 4096;

  private failures = new Map<string, number[]>();
  private blocked = new Map<string, number>();

  constructor(private now: () => number = Date.now) {}

  /** Milliseconds until the client may try again, or 0 */
  blockedFor(key: string): number {
    const until = this.blocked.get(key);
    if (until === undefined) return 0;
    const left = until - this.now();
    if (left > 0) return left;
    this.blocked.delete(key);
    return 0;
  }

  /** Records a wrong login; true if this one blocked the client */
  fail(key: string): boolean {
    const now = this.now();
    const recent = (this.failures.get(key) ?? []).filter((t) => now - t < LoginLimiter.WINDOW_MS);
    recent.push(now);
    this.failures.delete(key);
    if (recent.length >= LoginLimiter.MAX_FAILURES) {
      this.blocked.set(key, now + LoginLimiter.BLOCK_MS);
      return true;
    }
    this.failures.set(key, recent);
    // Oldest entries first in a Map, so drop from the front
    for (const map of [this.failures, this.blocked] as Map<string, unknown>[]) {
      while (map.size > LoginLimiter.MAX_TRACKED) map.delete(map.keys().next().value!);
    }
    return false;
  }

  succeed(key: string) {
    this.failures.delete(key);
  }

  sweep() {
    const now = this.now();
    for (const [k, times] of this.failures) {
      if (times.every((t) => now - t >= LoginLimiter.WINDOW_MS)) this.failures.delete(k);
    }
    for (const [k, until] of this.blocked) if (until <= now) this.blocked.delete(k);
  }

  get size() {
    return this.failures.size + this.blocked.size;
  }
}
