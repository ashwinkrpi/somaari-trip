import crypto from 'crypto';
import type express from 'express';
import { tooManyRequests } from './rateLimit.ts';

// AUTH_HASH format: scrypt:N:r:p:<salt base64url>:<hash base64url>
// No '$' so docker compose doesn't try to interpolate it from .env
const KEY_LEN = 32;

function scrypt(password: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // maxmem must cover 128 * N * r bytes, which is exactly the default limit at N=16384
    crypto.scrypt(password, salt, KEY_LEN, { N, r, p, maxmem: 256 * N * r }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string, N = 16384, r = 8, p = 1): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, N, r, p);
  return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join(':');
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

export function parseAuthHash(encoded: string): ParsedHash | null {
  const parts = encoded.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], 'base64url');
  const key = Buffer.from(parts[5], 'base64url');
  // N must be a power of two
  if (!Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1 || !Number.isInteger(p) || p < 1) return null;
  if (salt.length < 8 || key.length !== KEY_LEN) return null;
  return { N, r, p, salt, key };
}

async function verifyPassword(password: string, h: ParsedHash): Promise<boolean> {
  const key = await scrypt(password, h.salt, h.N, h.r, h.p);
  return crypto.timingSafeEqual(key, h.key);
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest();

export interface BasicAuthOptions {
  user: string;
  hash: string;
  /** Called before checking credentials; return false to reject with 429 (too many failures) */
  allowAttempt: (req: express.Request) => boolean;
  /** Called after a wrong user/password */
  onFailure: (req: express.Request) => void;
}

/**
 * HTTP basic auth against an scrypt hash. Every asset and API call carries the header,
 * so a header that verified once is remembered (by its SHA-256) to skip scrypt next time.
 */
export function basicAuth({ user, hash, allowAttempt, onFailure }: BasicAuthOptions): express.RequestHandler {
  const parsed = parseAuthHash(hash);
  if (!parsed) throw new Error('AUTH_HASH is not a valid scrypt hash (run npm run hash-password)');
  const expectedUser = sha256(user);
  const verified = new Set<string>();

  const challenge = (res: express.Response) => {
    res.set('WWW-Authenticate', 'Basic realm="Somaari Trip", charset="UTF-8"');
    res.status(401).json({ error: 'Unauthorized' });
  };

  return async (req, res, next) => {
    const header = req.get('authorization');
    if (!header?.startsWith('Basic ')) return challenge(res);

    const headerKey = sha256(header).toString('hex');
    if (verified.has(headerKey)) return next();

    if (!allowAttempt(req)) return tooManyRequests(res);

    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const givenUser = sep >= 0 ? decoded.slice(0, sep) : '';
    const givenPass = sep >= 0 ? decoded.slice(sep + 1) : '';

    try {
      // Always run scrypt so a wrong user takes as long as a wrong password
      const passOk = await verifyPassword(givenPass, parsed);
      const userOk = crypto.timingSafeEqual(sha256(givenUser), expectedUser);
      if (passOk && userOk) {
        // Only one user, so this stays tiny; clear it rather than grow if headers churn
        if (verified.size >= 16) verified.clear();
        verified.add(headerKey);
        return next();
      }
    } catch (err) {
      return next(err);
    }

    onFailure(req);
    challenge(res);
  };
}
