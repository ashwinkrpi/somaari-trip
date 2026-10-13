import path from 'path';
import { createApp } from './server/app.ts';
import { parseAuthHash } from './server/auth.ts';
import { ensureSampleData } from './server/seedData.ts';

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
// Prod runs in a container; dev should not be reachable from the LAN
const HOST = IS_PROD ? '0.0.0.0' : '127.0.0.1';
const DATA_DIR = path.join(process.cwd(), 'data');

const { AUTH_USER, AUTH_HASH } = process.env;
let auth: { user: string; hash: string } | undefined;
if (AUTH_USER && AUTH_HASH) {
  if (!parseAuthHash(AUTH_HASH)) {
    console.error('AUTH_HASH is not a valid scrypt hash (generate one with npm run hash-password)');
    process.exit(1);
  }
  auth = { user: AUTH_USER, hash: AUTH_HASH };
} else if (IS_PROD) {
  console.error('AUTH_USER and AUTH_HASH are required in production (npm run hash-password)');
  process.exit(1);
} else {
  console.warn('AUTH_USER/AUTH_HASH not set: no login required (dev only)');
}

// Ensure sample data exists on launch
ensureSampleData(DATA_DIR);

const { app, sweep } = createApp({
  dataDir: DATA_DIR,
  distDir: IS_PROD ? path.join(process.cwd(), 'dist') : undefined,
  auth,
  overlandToken: process.env.OVERLAND_TOKEN || undefined,
  seed: process.env.SEED_SAMPLE_DATA === 'true',
  csp: IS_PROD,
  tileCacheDir: IS_PROD ? path.join(process.cwd(), 'cache', 'tiles') : undefined,
});
setInterval(sweep, 60_000).unref();

async function startServer() {
  if (!IS_PROD) {
    // Loaded lazily so the production image doesn't need vite installed
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const server = app.listen(PORT, HOST, () => {
    console.log(`Somaari Trip server listening on http://${HOST}:${PORT}`);
  });
  // Faces the network directly, so don't let slow clients hold connections open
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
}

startServer();
