import fs from 'fs';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import type { Server } from 'http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import type express from 'express';
import { hashPassword } from './auth.ts';
import { AuthStore, logoutAll, writeAuthFile } from './authStore.ts';
import { LoginLimiter, TokenBuckets } from './rateLimit.ts';

const TOKEN = 'overland-test-token';
const JS = 'console.log("hello");'.repeat(100);

const USER = 'owner';
const PASSWORD = 'correct horse battery';

let tmp: string;
let authFile: string;
let base: string;
let cookie: string;
const servers: Server[] = [];

async function listen(app: express.Express): Promise<string> {
  const srv = app.listen(0, '127.0.0.1');
  servers.push(srv);
  await new Promise((r) => srv.once('listening', r));
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}

const appOptions = (dataDir: string, distDir: string) => ({
  dataDir,
  distDir,
  auth: new AuthStore(authFile),
  loginFailureDelayMs: 0,
  overlandToken: TOKEN,
  csp: true,
  tileCacheDir: path.join(tmp, 'tiles'),
});

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'somaari-app-'));
  const dataDir = path.join(tmp, 'data');
  const distDir = path.join(tmp, 'dist');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><div id="root"></div>');
  fs.writeFileSync(path.join(distDir, 'server.cjs'), 'secret');
  fs.writeFileSync(path.join(distDir, 'assets/app-abc.js'), JS);
  fs.writeFileSync(path.join(distDir, 'assets/app-abc.js.br'), zlib.brotliCompressSync(JS));
  fs.writeFileSync(path.join(distDir, 'assets/app-abc.js.gz'), zlib.gzipSync(JS));

  // Low scrypt cost keeps the tests fast
  authFile = path.join(dataDir, 'auth.json');
  writeAuthFile(authFile, USER, await hashPassword(PASSWORD, 1024));

  base = await listen(createApp(appOptions(dataDir, distDir)).app);
  cookie = await login(base);
});

afterAll(() => {
  for (const s of servers) s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const get = (p: string, headers: Record<string, string> = {}, at = base) => fetch(at + p, { headers });

const postJson = (p: string, body: unknown, headers: Record<string, string> = {}, at = base) =>
  fetch(at + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

/** Logs in and returns the Cookie header to send */
async function login(at: string, remember = false): Promise<string> {
  const res = await postJson('/api/login', { user: USER, password: PASSWORD, remember }, {}, at);
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie')!.split(';')[0];
}

describe('login', () => {
  it('serves the app without a login, but no data', async () => {
    expect((await get('/')).status).toBe(200);
    expect((await get('/assets/app-abc.js')).status).toBe(200);
    for (const p of ['/api/days', '/api/trips', '/tiles/osm/1/0/0.png']) {
      const res = await get(p);
      expect(res.status).toBe(401);
      // No WWW-Authenticate, so the browser doesn't show its own popup
      expect(res.headers.get('www-authenticate')).toBeNull();
    }
  });

  it('reports the session state', async () => {
    expect(await (await get('/api/session')).json()).toEqual({ loginRequired: true, authenticated: false });
    expect(await (await get('/api/session', { cookie })).json()).toEqual({
      loginRequired: true,
      authenticated: true,
      user: USER,
    });
  });

  it('rejects a wrong password or user', async () => {
    for (const body of [
      { user: USER, password: 'nope nope nope' },
      { user: 'other', password: PASSWORD },
      { user: USER },
    ]) {
      const res = await postJson('/api/login', body);
      expect([400, 401]).toContain(res.status);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
  });

  it('sets an HttpOnly SameSite=Strict cookie, kept 30 days only when asked', async () => {
    const res = await postJson('/api/login', { user: USER, password: PASSWORD });
    const set = res.headers.get('set-cookie')!;
    expect(set).toMatch(/^somaari_trip_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict$/);
    const remembered = await postJson('/api/login', { user: USER, password: PASSWORD, remember: true });
    expect(remembered.headers.get('set-cookie')).toMatch(/; Max-Age=2592000$/);
  });

  it('accepts the session cookie', async () => {
    const res = await get('/api/days', { cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, count: 0 });
  });

  it('rejects a tampered cookie', async () => {
    const tampered = cookie.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
    expect((await get('/api/days', { cookie: tampered })).status).toBe(401);
  });

  it('only takes JSON logins from its own origin', async () => {
    const form = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `user=${USER}&password=${encodeURIComponent(PASSWORD)}`,
    });
    expect(form.status).toBe(403);
    const crossSite = await postJson('/api/login', { user: USER, password: PASSWORD }, { origin: 'http://evil.test' });
    expect(crossSite.status).toBe(403);
  });

  it('logs out by clearing the cookie', async () => {
    const res = await postJson('/api/logout', {}, { cookie });
    expect(res.headers.get('set-cookie')).toMatch(/^somaari_trip_session=; .*Max-Age=0/);
  });

  it('leaves health open', async () => {
    expect((await get('/api/health')).status).toBe(200);
  });

  it('ends every session when auth.json changes (logout-all, setpassword)', async () => {
    const before = await login(base);
    expect((await get('/api/days', { cookie: before })).status).toBe(200);
    logoutAll(authFile);
    expect((await get('/api/days', { cookie: before })).status).toBe(401);
    cookie = await login(base);
  });

  it('fails closed when auth.json is missing', async () => {
    const saved = fs.readFileSync(authFile);
    fs.rmSync(authFile);
    try {
      expect((await get('/api/days', { cookie })).status).toBe(401);
      expect((await postJson('/api/login', { user: USER, password: PASSWORD })).status).toBe(503);
    } finally {
      fs.writeFileSync(authFile, saved, { mode: 0o600 });
    }
  });
});

describe('no login (NO_LOGIN=true)', () => {
  it('serves data without a cookie', async () => {
    const at = await listen(createApp({ dataDir: path.join(tmp, 'data') }).app);
    expect((await get('/api/days', {}, at)).status).toBe(200);
    expect(await (await get('/api/session', {}, at)).json()).toEqual({ loginRequired: false, authenticated: true });
  });
});

describe('overland', () => {
  const post = (headers: Record<string, string>) =>
    fetch(base + '/api/overland', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ locations: [] }),
    });

  it('needs its token, not the login', async () => {
    expect((await post({})).status).toBe(401);
    expect((await post({ cookie })).status).toBe(401);
    expect((await post({ authorization: `Bearer ${TOKEN}` })).status).toBe(200);
  });
});

describe('headers', () => {
  it('sets security headers and CSP on every response', async () => {
    for (const res of [await get('/'), await get('/', { cookie })]) {
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('permissions-policy')).toContain('geolocation=()');
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(res.headers.get('x-powered-by')).toBeNull();
    }
  });
});

describe('static files', () => {
  it('serves the precompressed variant the client accepts', async () => {
    for (const enc of ['br', 'gzip']) {
      const res = await get('/assets/app-abc.js', { cookie, 'accept-encoding': enc });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-encoding')).toBe(enc);
      expect(res.headers.get('content-type')).toMatch(/javascript/);
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(res.headers.get('vary')).toMatch(/Accept-Encoding/i);
      expect(await res.text()).toBe(JS); // fetch decodes it
    }
  });

  it('serves the plain file without Accept-Encoding', async () => {
    const res = await get('/assets/app-abc.js', { cookie, 'accept-encoding': 'identity' });
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('content-length')).toBe(String(JS.length));
  });

  it('falls back to index.html (no-cache) and never serves the server bundle', async () => {
    for (const p of ['/', '/some/route', '/server.cjs']) {
      const res = await get(p, { cookie });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(await res.text()).toContain('id="root"');
    }
  });

  it('puts tiles behind login and 404s disallowed tile paths', async () => {
    expect((await get('/tiles/osm/1/0/0.png')).status).toBe(401);
    expect((await get('/tiles/light_all/1/0/0.png', { cookie })).status).toBe(404);
  });

  it('returns 404 JSON for unknown API paths', async () => {
    const res = await get('/api/nope', { cookie });
    expect(res.status).toBe(404);
  });
});

describe('rate limit', () => {
  it('returns 429 after the burst', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) statuses.push((await get('/api/health')).status);
    expect(statuses).toContain(429);
  });

  it('blocks a client after 5 wrong passwords, even for the right one', async () => {
    const at = await listen(createApp(appOptions(path.join(tmp, 'data'), path.join(tmp, 'dist'))).app);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await postJson('/api/login', { user: USER, password: 'guess guess guess' }, {}, at)).status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 429]);
    const right = await postJson('/api/login', { user: USER, password: PASSWORD }, {}, at);
    expect(right.status).toBe(429);
    expect(Number(right.headers.get('retry-after'))).toBeGreaterThan(800);
  });
});

describe('LoginLimiter', () => {
  it('blocks for 15 minutes after 5 failures within 15 minutes', () => {
    let now = 0;
    const l = new LoginLimiter(() => now);
    for (let i = 0; i < 4; i++) expect(l.fail('a')).toBe(false);
    expect(l.blockedFor('b')).toBe(0);
    expect(l.fail('a')).toBe(true);
    expect(l.blockedFor('a')).toBe(15 * 60_000);
    now = 15 * 60_000;
    expect(l.blockedFor('a')).toBe(0);
  });

  it('forgets old failures and clears on success', () => {
    let now = 0;
    const l = new LoginLimiter(() => now);
    for (let i = 0; i < 4; i++) l.fail('a');
    now = 16 * 60_000;
    expect(l.fail('a')).toBe(false);
    l.succeed('a');
    for (let i = 0; i < 4; i++) expect(l.fail('a')).toBe(false);
    now = 40 * 60_000;
    l.sweep();
    expect(l.size).toBe(0);
  });
});

describe('TokenBuckets', () => {
  it('allows the burst, then refills at the rate', () => {
    let now = 0;
    const b = new TokenBuckets(2, 3, () => now);
    expect([b.take('a'), b.take('a'), b.take('a'), b.take('a')]).toEqual([true, true, true, false]);
    expect(b.take('b')).toBe(true);
    now = 500;
    expect(b.take('a')).toBe(true);
    expect(b.take('a')).toBe(false);
  });

  it('sweeps buckets that are full again', () => {
    let now = 0;
    const b = new TokenBuckets(1, 2, () => now);
    b.take('a');
    b.sweep();
    expect(b.size).toBe(1);
    now = 2000;
    b.sweep();
    expect(b.size).toBe(0);
  });
});
