// Decides on startup whether there is a login, and creates auth.json on first start.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { hashPassword, parseAuthHash } from './auth.ts';
import { AUTH_FILE, AuthStore, readAuthFile, validUser, writeAuthFile } from './authStore.ts';

export const DEFAULT_USER = 'admin';

// No 0/O, 1/l/I: easy to read off a terminal and type
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomPassword(length = 16): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

export type AuthSetup = { store?: AuthStore; messages: string[]; error?: string };

/**
 * - NO_LOGIN=true: no login.
 * - auth.json in the data folder: use it.
 * - Otherwise AUTH_USER/AUTH_HASH from older installs are imported into auth.json once.
 * - Otherwise production makes a random password and prints it once; dev runs without a login.
 */
export async function setupAuth(env: NodeJS.ProcessEnv, isProd: boolean, dataDir: string): Promise<AuthSetup> {
  const { AUTH_USER, AUTH_HASH, NO_LOGIN } = env;
  const file = path.join(dataDir, AUTH_FILE);
  const messages: string[] = [];

  if (NO_LOGIN === 'true') {
    return {
      messages: ['NO_LOGIN=true: no login, anyone who can reach this port can see your location history'],
    };
  }
  if (NO_LOGIN && NO_LOGIN !== 'false') return { messages, error: 'NO_LOGIN must be true or false' };

  try {
    const existing = readAuthFile(file);
    if (existing) {
      if (AUTH_USER || AUTH_HASH) {
        messages.push(`AUTH_USER/AUTH_HASH are ignored: the login is in ${file}. You can remove them from .env`);
      }
      return { store: new AuthStore(file), messages };
    }

    if (AUTH_USER || AUTH_HASH) {
      if (!AUTH_USER || !AUTH_HASH) return { messages, error: 'Set both AUTH_USER and AUTH_HASH, or neither' };
      if (!validUser(AUTH_USER)) return { messages, error: 'AUTH_USER must not contain spaces or ":"' };
      if (!parseAuthHash(AUTH_HASH)) return { messages, error: 'AUTH_HASH is not a valid scrypt hash' };
      writeAuthFile(file, AUTH_USER, AUTH_HASH);
      messages.push(`Moved the login from AUTH_USER/AUTH_HASH into ${file}. You can remove them from .env`);
      return { store: new AuthStore(file), messages };
    }

    if (!isProd) {
      messages.push('No login (dev). To try the login screen: npm run setpassword');
      return { messages };
    }

    if (!fs.existsSync(dataDir)) return { messages, error: `${dataDir} doesn't exist` };
    const password = randomPassword();
    writeAuthFile(file, DEFAULT_USER, await hashPassword(password));
    messages.push(
      'No login was set, so one was made. It is shown only this once:',
      `  user name: ${DEFAULT_USER}`,
      `  password:  ${password}`,
      'Change it with: docker exec -it somaari-trip somaari-trip setpassword',
    );
    return { store: new AuthStore(file), messages };
  } catch (err: any) {
    return { messages, error: err.message };
  }
}
