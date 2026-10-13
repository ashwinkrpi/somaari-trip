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
