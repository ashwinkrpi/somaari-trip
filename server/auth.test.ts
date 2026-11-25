import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword, parseAuthHash, verifyPassword } from './auth.ts';
import { randomPassword, setupAuth } from './authSetup.ts';
import { AuthStore, logoutAll, readAuthFile, writeAuthFile } from './authStore.ts';
import { runCli } from './cli.ts';
import {
  BROWSER_SECS,
  decodeSession,
  encodeSession,
  newSession,
  readCookie,
  REMEMBER_SECS,
  renewal,
} from './session.ts';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'somaari-auth-'));
  file = path.join(dir, 'auth.json');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const fastHash = (pw: string) => hashPassword(pw, 1024);

describe('auth.json', () => {
  it('round-trips, is owner-only, and rotates the session secret on every write', async () => {
    const hash = await fastHash('correct horse battery');
    writeAuthFile(file, 'owner', hash);
    const first = readAuthFile(file)!;
    expect(first.user).toBe('owner');
    expect(first.passwordHash).toBe(hash);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    logoutAll(file);
    const second = readAuthFile(file)!;
    expect(second.passwordHash).toBe(hash);
    expect(second.sessionSecret.equals(first.sessionSecret)).toBe(false);
  });

  it('is null when missing and throws when broken', () => {
    expect(readAuthFile(file)).toBeNull();
    fs.writeFileSync(file, '{"version":1}');
    expect(() => readAuthFile(file)).toThrow(/no usable user/);
  });

  it('rejects bad user names', async () => {
    const hash = await fastHash('correct horse battery');
    for (const user of ['', 'a b', 'a:b']) expect(() => writeAuthFile(file, user, hash)).toThrow();
  });

  it('AuthStore reloads after a change and is null (fail closed) when missing', async () => {
    writeAuthFile(file, 'owner', await fastHash('correct horse battery'));
    const store = new AuthStore(file);
    const secret = store.get()!.sessionSecret;
    logoutAll(file);
    expect(store.get()!.sessionSecret.equals(secret)).toBe(false);
    fs.rmSync(file);
    expect(store.get()).toBeNull();
  });
});

describe('setupAuth', () => {
  it('uses an existing auth.json', async () => {
    writeAuthFile(file, 'owner', await fastHash('correct horse battery'));
    const r = await setupAuth({}, true, dir);
    expect(r.error).toBeUndefined();
    expect(r.store?.get()?.user).toBe('owner');
  });

  it('imports AUTH_USER/AUTH_HASH from older installs, once', async () => {
    const hash = await fastHash('correct horse battery');
    const r = await setupAuth({ AUTH_USER: 'owner', AUTH_HASH: hash }, true, dir);
    expect(r.messages.join()).toMatch(/Moved the login/);
    expect(readAuthFile(file)).toMatchObject({ user: 'owner', passwordHash: hash });
    const again = await setupAuth({ AUTH_USER: 'owner', AUTH_HASH: hash }, true, dir);
    expect(again.messages.join()).toMatch(/are ignored/);
  });

  it('rejects a mangled AUTH_HASH', async () => {
    expect((await setupAuth({ AUTH_USER: 'u', AUTH_HASH: 'scrypt:1' }, true, dir)).error).toMatch(/not a valid/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('makes a random password on the first production start and prints it once', async () => {
    const r = await setupAuth({}, true, dir);
    const printed = /password: +(\S+)/.exec(r.messages.join('\n'))![1];
    const saved = readAuthFile(file)!;
    expect(saved.user).toBe('admin');
    expect(await verifyPassword(printed, saved.parsedHash)).toBe(true);
    expect((await setupAuth({}, true, dir)).messages.join()).not.toContain(printed);
  });

  it('runs without a login with NO_LOGIN=true, or in dev without auth.json', async () => {
    expect((await setupAuth({ NO_LOGIN: 'true' }, true, dir)).store).toBeUndefined();
    expect((await setupAuth({}, false, dir)).store).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('rejects NO_LOGIN values other than true or false', async () => {
    expect((await setupAuth({ NO_LOGIN: 'yes' }, true, dir)).error).toMatch(/true or false/);
  });
});

describe('sessions', () => {
  const secret = Buffer.alloc(32, 7);
  const now = 1_800_000_000;

  it('round-trips and rejects another secret or tampering', () => {
    const s = newSession('browser', now);
    const token = encodeSession(s, secret);
    expect(decodeSession(token, secret, now)).toEqual(s);
    expect(decodeSession(token, Buffer.alloc(32, 8), now)).toBeNull();
    expect(decodeSession(token.replace('.b.', '.r.'), secret, now)).toBeNull();
    expect(decodeSession('garbage', secret, now)).toBeNull();
  });

  it('expires after a day (browser) or 30 days (remember)', () => {
    const b = encodeSession(newSession('browser', now), secret);
    expect(decodeSession(b, secret, now + BROWSER_SECS - 1)).not.toBeNull();
    expect(decodeSession(b, secret, now + BROWSER_SECS)).toBeNull();
    const r = encodeSession(newSession('remember', now), secret);
    expect(decodeSession(r, secret, now + REMEMBER_SECS - 1)).not.toBeNull();
    expect(decodeSession(r, secret, now + REMEMBER_SECS)).toBeNull();
  });

  it('renews only browser sessions older than an hour', () => {
    expect(renewal(newSession('browser', now), now + 60)).toBeNull();
    expect(renewal(newSession('browser', now), now + 3600)?.issued).toBe(now + 3600);
    expect(renewal(newSession('remember', now), now + 3600)).toBeNull();
  });

  it('reads the cookie by name', () => {
    expect(readCookie('a=1; somaari_trip_session=xyz; b=2')).toBe('xyz');
    expect(readCookie('somaari_trip_session_other=1')).toBeUndefined();
  });
});

describe('cli', () => {
  const run = async (args: string[], stdin?: string) => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m) => void out.push(String(m)));
    vi.spyOn(console, 'error').mockImplementation((m) => void out.push(String(m)));
    if (stdin !== undefined) {
      const { Readable } = await import('stream');
      vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from([stdin]) as any);
    }
    const code = await runCli(args, dir);
    vi.restoreAllMocks();
    return { code, out: out.join('\n') };
  };

  it('setpassword --random makes a working password and prints it once', async () => {
    const { code, out } = await run(['setpassword', '--user', 'owner', '--random']);
    expect(code).toBe(0);
    const pw = /password: (\S+)/.exec(out)![1];
    const saved = readAuthFile(file)!;
    expect(saved.user).toBe('owner');
    expect(await verifyPassword(pw, saved.parsedHash)).toBe(true);
  });

  it('setpassword reads a piped password, keeps the user name and logs everyone out', async () => {
    writeAuthFile(file, 'owner', await fastHash('correct horse battery'));
    const before = readAuthFile(file)!.sessionSecret;
    expect((await run(['setpassword'], 'another long password\n')).code).toBe(0);
    const saved = readAuthFile(file)!;
    expect(saved.user).toBe('owner');
    expect(await verifyPassword('another long password', saved.parsedHash)).toBe(true);
    expect(saved.sessionSecret.equals(before)).toBe(false);
  });

  it('refuses a short password and changes nothing', async () => {
    const { code, out } = await run(['setpassword'], 'short\n');
    expect(code).toBe(1);
    expect(out).toMatch(/at least 12/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('logout-all keeps the password; unknown commands print usage', async () => {
    writeAuthFile(file, 'owner', await fastHash('correct horse battery'));
    const hash = readAuthFile(file)!.passwordHash;
    expect((await run(['logout-all'])).code).toBe(0);
    expect(readAuthFile(file)!.passwordHash).toBe(hash);
    expect((await run(['nope'])).code).toBe(2);
  });

  it('random passwords are 16 unambiguous characters', () => {
    const pw = randomPassword();
    expect(pw).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{16}$/);
  });
});

it('hash format still parses', async () => {
  expect(parseAuthHash(await fastHash('correct horse battery'))).not.toBeNull();
});
