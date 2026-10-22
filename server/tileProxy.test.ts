import fs from 'fs';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createTileProxy, parseTilePath, type TileProxyOptions } from './tileProxy.ts';

const PNG = Buffer.from('\x89PNG fake tile');

let tmp: string;
let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

/** Fake upstream: records each call and answers with `reply` */
function upstream(reply: () => Response | Promise<Response> = () => new Response(PNG)) {
  const calls: { url: string; headers: Headers }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: new Headers(init?.headers) });
    return reply();
  }) as typeof fetch;
  return { calls, fetchFn };
}

async function start(opts: Omit<TileProxyOptions, 'cacheDir'>) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'somaari-tiles-'));
  const proxy = createTileProxy({ cacheDir: tmp, ...opts });
  await proxy.ready;
  const app = express();
  app.use('/tiles', proxy.handler);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server!.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return (p: string) => fetch(base + p);
}

describe('parseTilePath', () => {
  it('maps OSM tiles to their upstream', () => {
    expect(parseTilePath('/osm/3/1/2.png')).toEqual({ key: 'osm/3/1/2.png', url: 'https://tile.openstreetmap.org/3/1/2.png' });
  });

  it('rejects anything else', () => {
    for (const p of [
      '/light_all/3/1/2.png',
      '/osm/3/1/2@2x.png',
      '/osm/3/1/2.jpg',
      '/osm/3/-1/2.png',
      '/osm/3/1.5/2.png',
      '/osm/3/8/0.png', // x out of range at z=3
      '/osm/20/0/0.png',
      '/osm/../../etc/passwd',
      '/osm/3/1/2.png?x=1',
    ]) {
      expect(parseTilePath(p), p).toBeUndefined();
    }
  });

  it('rejects the removed dark and voyager styles', () => {
    expect(parseTilePath('/dark_all/3/1/2.png')).toBeUndefined();
    expect(parseTilePath('/rastertiles/voyager/3/1/2@2x.png')).toBeUndefined();
  });
});

describe('tile proxy', () => {
  it('404s disallowed paths without contacting upstream', async () => {
    const { calls, fetchFn } = upstream();
    const get = await start({ fetch: fetchFn });
    expect((await get('/tiles/light_all/1/0/0.png')).status).toBe(404);
    expect((await get('/tiles/dark_all/1/0/0.png')).status).toBe(404);
    expect((await get('/tiles/')).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('fetches a miss with only UA and Accept, then serves it from disk', async () => {
    const { calls, fetchFn } = upstream();
    const get = await start({ fetch: fetchFn });

    const miss = await get('/tiles/osm/3/1/2.png');
    expect(miss.status).toBe(200);
    expect(miss.headers.get('x-cache-status')).toBe('MISS');
    expect(miss.headers.get('content-type')).toBe('image/png');
    expect(miss.headers.get('cache-control')).toBe('private, max-age=604800');
    expect(Buffer.from(await miss.arrayBuffer())).toEqual(PNG);
    expect(fs.readFileSync(path.join(tmp, 'osm/3/1/2.png'))).toEqual(PNG);

    const hit = await get('/tiles/osm/3/1/2.png');
    expect(hit.headers.get('x-cache-status')).toBe('HIT');
    expect(Buffer.from(await hit.arrayBuffer())).toEqual(PNG);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://tile.openstreetmap.org/3/1/2.png');
    expect([...calls[0].headers.keys()].sort()).toEqual(['accept', 'user-agent']);
    expect(calls[0].headers.get('user-agent')).toMatch(/^somaari-trip\//);
  });

  it('collapses concurrent misses into one upstream request', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { calls, fetchFn } = upstream(async () => {
      await gate;
      return new Response(PNG);
    });
    const get = await start({ fetch: fetchFn });
    const responses = Array.from({ length: 5 }, () => get('/tiles/osm/2/1/1.png'));
    await new Promise((r) => setTimeout(r, 50));
    release();
    for (const res of await Promise.all(responses)) expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('does not cache errors', async () => {
    let status = 404;
    const { calls, fetchFn } = upstream(() => new Response('nope', { status }));
    const get = await start({ fetch: fetchFn });
    expect((await get('/tiles/osm/1/0/0.png')).status).toBe(404);
    status = 503;
    expect((await get('/tiles/osm/1/0/0.png')).status).toBe(502);
    expect(calls).toHaveLength(2);
    expect(fs.existsSync(path.join(tmp, 'osm/1/0/0.png'))).toBe(false);
  });

  it('refreshes expired tiles and serves stale ones when upstream fails', async () => {
    let now = Date.now();
    let fail = false;
    const { calls, fetchFn } = upstream(() => {
      if (fail) throw new Error('offline');
      return new Response(PNG);
    });
    const get = await start({ fetch: fetchFn, now: () => now, maxAgeMs: 1000 });

    expect((await get('/tiles/osm/1/1/1.png')).headers.get('x-cache-status')).toBe('MISS');
    now += 2000;
    expect((await get('/tiles/osm/1/1/1.png')).headers.get('x-cache-status')).toBe('EXPIRED');
    now += 2000;
    fail = true;
    const stale = await get('/tiles/osm/1/1/1.png');
    expect(stale.status).toBe(200);
    expect(stale.headers.get('x-cache-status')).toBe('STALE');
    expect(Buffer.from(await stale.arrayBuffer())).toEqual(PNG);
    expect(calls).toHaveLength(3);
  });

  it('evicts the oldest tiles when over the size cap', async () => {
    const { fetchFn } = upstream();
    // Room for 3 tiles; eviction goes down to 90% of the cap, so 2 remain
    const get = await start({ fetch: fetchFn, maxBytes: PNG.length * 3 });
    const tiles = ['osm/2/0/0.png', 'osm/2/0/1.png', 'osm/2/0/2.png', 'osm/2/0/3.png'];
    for (const [i, t] of tiles.entries()) {
      await (await get(`/tiles/${t}`)).arrayBuffer();
      // Distinct, increasing mtimes regardless of filesystem timestamp resolution
      const at = new Date(Date.now() - (tiles.length - i) * 60_000);
      fs.utimesSync(path.join(tmp, t), at, at);
    }
    await new Promise((r) => setTimeout(r, 50));
    const left = tiles.filter((t) => fs.existsSync(path.join(tmp, t)));
    expect(left).toEqual(tiles.slice(2));
  });

  it('removes temp files left over from a crash at startup', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'somaari-tiles-'));
    fs.mkdirSync(path.join(tmp, 'osm/1/0'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'osm/1/0/0.png.abc.tmp'), 'partial');
    const proxy = createTileProxy({ cacheDir: tmp, fetch: upstream().fetchFn });
    await proxy.ready;
    expect(fs.existsSync(path.join(tmp, 'osm/1/0/0.png.abc.tmp'))).toBe(false);
  });
});
