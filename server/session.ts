// Signed session cookies, no server-side store. Changing the session secret (setpassword,
// logout-all) ends every session.
import crypto from 'crypto';

export const COOKIE = 'somaari_trip_session';
export const REMEMBER_SECS = 30 * 24 * 3600;
/** A browser session ends after a day without use */
export const BROWSER_SECS = 24 * 3600;
/** A browser session in use gets a fresh time once it is this old */
export const RENEW_AFTER_SECS = 3600;
const SKEW_SECS = 300;

export type SessionKind = 'remember' | 'browser';

export interface Session {
  kind: SessionKind;
  /** Unix seconds */
  issued: number;
  nonce: string;
}

const TAGS: Record<SessionKind, string> = { remember: 'r', browser: 'b' };
const lifetime = (kind: SessionKind) => (kind === 'remember' ? REMEMBER_SECS : BROWSER_SECS);

const sign = (secret: Buffer, body: string) => crypto.createHmac('sha256', secret).update(body).digest();

export function newSession(kind: SessionKind, now: number): Session {
  return { kind, issued: now, nonce: crypto.randomBytes(16).toString('hex') };
}

export function encodeSession(s: Session, secret: Buffer): string {
  const body = `1.${TAGS[s.kind]}.${s.issued}.${s.nonce}`;
  return `${body}.${sign(secret, body).toString('hex')}`;
}

/** Checks the signature (constant time) and expiry; null for anything wrong */
export function decodeSession(token: string, secret: Buffer, now: number): Session | null {
  if (token.length > 200) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1), 'hex');
  const expected = sign(secret, body);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;

  const [version, tag, issuedStr, nonce, ...rest] = body.split('.');
  if (version !== '1' || rest.length || !/^[0-9a-f]{32}$/.test(nonce ?? '')) return null;
  const kind = tag === 'r' ? 'remember' : tag === 'b' ? 'browser' : null;
  if (!kind || !/^\d+$/.test(issuedStr)) return null;
  const issued = Number(issuedStr);
  if (issued > now + SKEW_SECS || now >= issued + lifetime(kind)) return null;
  return { kind, issued, nonce };
}

/** A browser session older than an hour gets a fresh issued time, so it lasts while in use */
export function renewal(s: Session, now: number): Session | null {
  return s.kind === 'browser' && now - s.issued >= RENEW_AFTER_SECS ? { ...s, issued: now } : null;
}

/** HttpOnly, SameSite=Strict, no Secure (the app runs on plain HTTP on a private network) */
export function sessionCookie(s: Session, secret: Buffer): string {
  let c = `${COOKIE}=${encodeSession(s, secret)}; Path=/; HttpOnly; SameSite=Strict`;
  if (s.kind === 'remember') c += `; Max-Age=${REMEMBER_SECS}`;
  return c;
}

export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

export function readCookie(header: string | undefined, name = COOKIE): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}
