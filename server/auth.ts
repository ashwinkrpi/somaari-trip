import crypto from 'crypto';

// Password hash format: scrypt:N:r:p:<salt base64url>:<hash base64url>
// No '$' so docker compose doesn't try to interpolate it from .env (old AUTH_HASH lines)
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

export interface ParsedHash {
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

export async function verifyPassword(password: string, h: ParsedHash): Promise<boolean> {
  const key = await scrypt(password, h.salt, h.N, h.r, h.p);
  return crypto.timingSafeEqual(key, h.key);
}

/** Shortest password setpassword accepts */
export const MIN_PASSWORD_LENGTH = 12;
