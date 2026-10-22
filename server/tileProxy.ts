import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import express from 'express';

// Only OpenStreetMap tile URLs are fetched, so the proxy can't be pointed anywhere else
const OSM_RE = /^\/osm\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png$/;
const MAX_ZOOM = 19;

const USER_AGENT = 'somaari-trip/1.0 (self-hosted personal tile cache)';
const UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_TILE_BYTES = 1024 * 1024;
const EVICT_INTERVAL_MS = 60_000;

export interface TileProxyOptions {
  cacheDir: string;
  /** Total cache size; oldest tiles (by mtime) are evicted above it. Default 1 GB */
  maxBytes?: number;
  /** Tiles older than this are refetched (stale copy served if that fails). Default 30 days */
  maxAgeMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

interface Tile {
  /** Cache key, also the path under cacheDir */
  key: string;
  url: string;
}

/** Upstream status; body only when the tile was fetched */
interface Fetched {
  status: number;
  body?: Buffer;
}

/** Maps /osm/<z>/<x>/<y>.png to its upstream URL, or undefined if not allowed */
export function parseTilePath(p: string): Tile | undefined {
  const m = OSM_RE.exec(p);
  if (!m) return undefined;
  const [, zs, xs, ys] = m;
  const z = Number(zs);
  const x = Number(xs);
  const y = Number(ys);
  if (z > MAX_ZOOM || x >= 2 ** z || y >= 2 ** z) return undefined;
  const tilePath = `${z}/${x}/${y}.png`;
  return { key: `osm/${tilePath}`, url: `https://tile.openstreetmap.org/${tilePath}` };
}

async function walk(
  dir: string,
  removeTmp = false,
): Promise<{ file: string; size: number; mtimeMs: number }[]> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: { file: string; size: number; mtimeMs: number }[] = [];
  for (const e of entries) {
    const file = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walk(file, removeTmp)));
    } else if (e.name.endsWith('.tmp')) {
      // Left over from a crash mid-write (only at startup: later ones may be in progress)
      if (removeTmp) await fs.promises.rm(file, { force: true });
    } else {
      const st = await fs.promises.stat(file).catch(() => undefined);
      if (st) out.push({ file, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

/**
 * GET /tiles/osm/<z>/<x>/<y>.png: fetches OpenStreetMap tiles and caches them on disk, so the
 * tile server only sees this server (once per tile), never the browser.
 * Nothing from the browser's request is forwarded upstream.
 */
export function createTileProxy(opts: TileProxyOptions) {
  const {
    cacheDir,
    maxBytes = 1024 ** 3,
    maxAgeMs = 30 * 24 * 3600_000,
    fetch: fetchFn = fetch,
    now = Date.now,
  } = opts;
  const inflight = new Map<string, Promise<Fetched>>();
  let totalBytes = 0;
  let lastEvict = -Infinity;
  let evicting = false;

  const ready = walk(cacheDir, true).then((files) => {
    totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  });

  async function evictIfOver() {
    if (totalBytes <= maxBytes || evicting || now() - lastEvict < EVICT_INTERVAL_MS) return;
    evicting = true;
    lastEvict = now();
    try {
      const files = await walk(cacheDir);
      files.sort((a, b) => a.mtimeMs - b.mtimeMs);
      let total = files.reduce((sum, f) => sum + f.size, 0);
      // Go a bit below the cap so this doesn't run again on the next few writes
      const target = maxBytes * 0.9;
      for (const f of files) {
        if (total <= target) break;
        await fs.promises.rm(f.file, { force: true });
        total -= f.size;
      }
      totalBytes = total;
    } catch (err) {
      console.error('Tile cache eviction failed:', err);
    } finally {
      evicting = false;
    }
  }

  async function fetchAndStore(tile: Tile, file: string, oldSize: number): Promise<Fetched> {
    let body: Buffer;
    try {
      const res = await fetchFn(tile.url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'image/png' },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (res.status !== 200) {
        await res.body?.cancel();
        return { status: res.status };
      }
      body = Buffer.from(await res.arrayBuffer());
      if (body.length === 0 || body.length > MAX_TILE_BYTES) return { status: 502 };
    } catch (err: any) {
      console.warn(`Tile fetch failed for ${tile.key}: ${err?.message ?? err}`);
      return { status: 502 };
    }

    // A failed write still serves the tile, it just isn't cached
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      await fs.promises.writeFile(tmp, body);
      await fs.promises.rename(tmp, file);
      totalBytes += body.length - oldSize;
      void evictIfOver();
    } catch (err) {
      console.error(`Tile cache write failed for ${tile.key}:`, err);
    }
    return { status: 200, body };
  }

  const handler: express.RequestHandler = async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const tile = parseTilePath(req.path);
    if (!tile) return res.status(404).end();

    const file = path.join(cacheDir, tile.key);
    const stat = await fs.promises.stat(file).catch(() => undefined);
    const send = (status: string) => {
      res.set({
        'Content-Type': 'image/png',
        'Cache-Control': 'private, max-age=604800',
        'X-Cache-Status': status,
      });
    };
    const sendFile = (status: string) => {
      send(status);
      fs.createReadStream(file).on('error', next).pipe(res);
    };

    if (stat && now() - stat.mtimeMs < maxAgeMs) return sendFile('HIT');

    // One upstream request per tile, however many clients ask for it at once
    let pending = inflight.get(tile.key);
    if (!pending) {
      pending = fetchAndStore(tile, file, stat?.size ?? 0).finally(() => inflight.delete(tile.key));
      inflight.set(tile.key, pending);
    }
    const result = await pending;

    if (result.body) {
      send(stat ? 'EXPIRED' : 'MISS');
      return res.send(result.body);
    }
    if (stat) return sendFile('STALE');
    res.status(result.status === 404 ? 404 : 502).end();
  };

  return { handler, ready };
}
