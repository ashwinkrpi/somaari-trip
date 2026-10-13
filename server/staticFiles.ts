import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import express from 'express';

interface StaticFile {
  file: string;
  size: number;
  br?: { file: string; size: number };
  gz?: { file: string; size: number };
}

function walk(dir: string, prefix = ''): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
  );
}

/**
 * Serves the Vite build from memory-indexed paths (dist never changes while running).
 * Picks the precompressed .br / .gz written at build time by Accept-Encoding; never compresses at runtime.
 * Unknown paths get index.html (SPA). The server bundle in dist/ is never served.
 */
export function serveStatic(distDir: string): express.RequestHandler {
  const files = new Map<string, StaticFile>();
  const all = new Set(walk(distDir));
  for (const rel of all) {
    if (rel.endsWith('.br') || rel.endsWith('.gz') || rel.startsWith('server.')) continue;
    const abs = path.join(distDir, rel);
    const variant = (ext: string) =>
      all.has(rel + ext) ? { file: abs + ext, size: fs.statSync(abs + ext).size } : undefined;
    files.set(`/${rel}`, { file: abs, size: fs.statSync(abs).size, br: variant('.br'), gz: variant('.gz') });
  }
  const index = files.get('/index.html');
  if (!index) throw new Error(`No index.html in ${distDir} (run npm run build)`);

  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const entry = files.get(req.path) ?? index;
    const accept = req.get('accept-encoding') ?? '';
    const chosen =
      (/\bbr\b/.test(accept) && entry.br) || (/\bgzip\b/.test(accept) && entry.gz) || undefined;

    res.type(path.extname(entry.file));
    res.set(
      'Cache-Control',
      req.path.startsWith('/assets/') && entry !== index
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    );
    if (entry.br || entry.gz) res.vary('Accept-Encoding');
    if (chosen) res.set('Content-Encoding', chosen === entry.br ? 'br' : 'gzip');
    const { file, size } = chosen ?? entry;
    res.set('Content-Length', String(size));

    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file)
      .on('error', next)
      .pipe(res);
  };
}

/** JSON body, gzipped (level 4) when larger than 1 KB and the client accepts it */
export function sendJson(req: express.Request, res: express.Response, body: unknown) {
  const json = JSON.stringify(body);
  res.type('json');
  res.vary('Accept-Encoding');
  if (json.length <= 1024 || !/\bgzip\b/.test(req.get('accept-encoding') ?? '')) {
    return res.send(json);
  }
  zlib.gzip(json, { level: 4 }, (err, gz) => {
    if (err) return res.send(json);
    res.set('Content-Encoding', 'gzip');
    res.send(gz);
  });
}
