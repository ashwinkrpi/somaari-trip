// auth.json in the data folder: user name, password hash and session secret.
//
// `setpassword` and `logout-all` write the file while the server may be running. The server
// notices on its next request: it compares the file's modified time and size (one stat, no
// background work) and reloads when they change.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { parseAuthHash, type ParsedHash } from './auth.ts';

export const AUTH_FILE = 'auth.json';

/** What the server works with. Never logged or sent to the browser. */
export interface Secrets {
  user: string;
  passwordHash: string;
  parsedHash: ParsedHash;
  sessionSecret: Buffer;
}

interface AuthFileJson {
  version: 1;
  user: string;
  password_hash: string;
  session_secret: string;
}

export function validUser(user: string): boolean {
  return user.length > 0 && user.length <= 64 && !/[\s:]/.test(user);
}

function parse(text: string): Secrets {
  let f: Partial<AuthFileJson>;
  try {
    f = JSON.parse(text);
  } catch {
    throw new Error('auth.json is not valid JSON');
  }
  if (f.version !== 1) throw new Error(`auth.json has unknown version ${f.version}`);
  if (typeof f.user !== 'string' || !validUser(f.user)) throw new Error('auth.json has no usable user');
  const parsedHash = typeof f.password_hash === 'string' ? parseAuthHash(f.password_hash) : null;
  if (!parsedHash) throw new Error('auth.json has no usable password hash');
  const secret = typeof f.session_secret === 'string' ? Buffer.from(f.session_secret, 'hex') : Buffer.alloc(0);
  if (secret.length !== 32) throw new Error('auth.json has no usable session secret');
  return { user: f.user, passwordHash: f.password_hash!, parsedHash, sessionSecret: secret };
}

/** Reads auth.json; null if it doesn't exist. Throws if it's unreadable or invalid. */
export function readAuthFile(file: string): Secrets | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`${file}: ${err.message}`);
  }
  try {
    return parse(text);
  } catch (err: any) {
    throw new Error(`${file}: ${err.message}`);
  }
}

/**
 * Writes auth.json (owner-only) with a fresh session secret, so every session ends.
 * Written to a temp file and renamed, so the server never reads half a file.
 */
export function writeAuthFile(file: string, user: string, passwordHash: string) {
  if (!validUser(user)) throw new Error('User name must be 1-64 characters, without spaces or ":"');
  if (!parseAuthHash(passwordHash)) throw new Error('Not a valid scrypt password hash');
  const json: AuthFileJson = {
    version: 1,
    user,
    password_hash: passwordHash,
    session_secret: crypto.randomBytes(32).toString('hex'),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(json, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Ends every session and keeps the password */
export function logoutAll(file: string) {
  const s = readAuthFile(file);
  if (!s) throw new Error(`${file} doesn't exist: there is no login to log out of`);
  writeAuthFile(file, s.user, s.passwordHash);
}

/** auth.json, reloaded when the file changes. get() is null if it's missing or broken (fail closed). */
export class AuthStore {
  private cached: Secrets | null = null;
  private stamp = '';

  constructor(readonly file: string) {}

  get(): Secrets | null {
    let stamp: string;
    try {
      const st = fs.statSync(this.file);
      stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {
      this.cached = null;
      this.stamp = '';
      return null;
    }
    if (stamp !== this.stamp) {
      try {
        this.cached = readAuthFile(this.file);
      } catch (err: any) {
        console.error(err.message);
        this.cached = null;
      }
      this.stamp = stamp;
    }
    return this.cached;
  }
}
