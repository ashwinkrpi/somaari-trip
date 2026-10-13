import fs from 'fs';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import type { Server } from 'http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { hashPassword } from './auth.ts';
import { TokenBuckets } from './rateLimit.ts';

const TOKEN = 'overland-test-token';
const JS = 'console.log("hello");'.repeat(100);

let tmp: string;
let server: Server;
let base: string;
let basic: string;

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
  const hash = await hashPassword('correct horse battery', 1024);
  basic = 'Basic ' + Buffer.from('owner:correct horse battery').toString('base64');

  const { app } = createApp({
    dataDir,
    distDir,
    auth: { user: 'owner', hash },
    overlandToken: TOKEN,
    csp: true,
    tileCacheDir: path.join(tmp, 'tiles'),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const get = (p: string, headers: Record<string, string> = {}) => fetch(base + p, { headers });

describe('basic auth', () => {
  it('rejects requests without credentials', async () => {
    for (const p of ['/', '/api/days', '/assets/app-abc.js']) {
      const res = await get(p);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(/^Basic realm=/);
    }
  });

  it('rejects a wrong password or user', async () => {
    const wrongPass = 'Basic ' + Buffer.from('owner:nope').toString('base64');
    const wrongUser = 'Basic ' + Buffer.from('other:correct horse battery').toString('base64');
    expect((await get('/api/days', { authorization: wrongPass })).status).toBe(401);
    expect((await get('/api/days', { authorization: wrongUser })).status).toBe(401);
  });

  it('accepts the right credentials', async () => {
    const res = await get('/api/days', { authorization: basic });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, count: 0 });
  });

  it('leaves health open', async () => {
    expect((await get('/api/health')).status).toBe(200);
  });
});

describe('overland', () => {
  const post = (headers: Record<string, string>) =>
    fetch(base + '/api/overland', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ locations: [] }),
    });

  it('needs its token, not basic auth', async () => {
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: basic })).status).toBe(401);
    expect((await post({ authorization: `Bearer ${TOKEN}` })).status).toBe(200);
  });
});

describe('headers', () => {
  it('sets security headers and CSP on every response', async () => {
    for (const res of [await get('/'), await get('/', { authorization: basic })]) {
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
      const res = await get('/assets/app-abc.js', { authorization: basic, 'accept-encoding': enc });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-encoding')).toBe(enc);
      expect(res.headers.get('content-type')).toMatch(/javascript/);
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(res.headers.get('vary')).toMatch(/Accept-Encoding/i);
      expect(await res.text()).toBe(JS); // fetch decodes it
    }
  });

  it('serves the plain file without Accept-Encoding', async () => {
    const res = await get('/assets/app-abc.js', { authorization: basic, 'accept-encoding': 'identity' });
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('content-length')).toBe(String(JS.length));
  });

  it('falls back to index.html (no-cache) and never serves the server bundle', async () => {
    for (const p of ['/', '/some/route', '/server.cjs']) {
      const res = await get(p, { authorization: basic });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(await res.text()).toContain('id="root"');
    }
  });

  it('puts tiles behind login and 404s disallowed tile paths', async () => {
    expect((await get('/tiles/osm/1/0/0.png')).status).toBe(401);
    expect((await get('/tiles/light_all/1/0/0.png', { authorization: basic })).status).toBe(404);
  });

  it('returns 404 JSON for unknown API paths', async () => {
    const res = await get('/api/nope', { authorization: basic });
    expect(res.status).toBe(404);
  });
});

describe('rate limit', () => {
  it('returns 429 after the burst', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) statuses.push((await get('/api/health')).status);
    expect(statuses).toContain(429);
  });

  it('limits wrong passwords before running scrypt', async () => {
    const wrong = 'Basic ' + Buffer.from('owner:guess').toString('base64');
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await get('/', { authorization: wrong })).status);
    expect(statuses.slice(0, 8)).toEqual(Array(8).fill(401));
    expect(statuses.at(-1)).toBe(429);
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
