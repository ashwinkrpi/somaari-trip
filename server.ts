import path from 'path';
import { createApp } from './server/app.ts';
import { setupAuth } from './server/authSetup.ts';
import { runCli } from './server/cli.ts';
import { ensureSampleData } from './server/seedData.ts';

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
// Prod runs in a container; dev should not be reachable from the LAN
const HOST = IS_PROD ? '0.0.0.0' : '127.0.0.1';
// Dev gets its own folder: ./data may hold real location history, and dev has no login by default
const DATA_DIR = path.join(process.cwd(), IS_PROD ? 'data' : 'data-dev');

async function main() {
  // Commands (setpassword, logout-all) instead of the server
  const args = process.argv.slice(2);
  if (args.length > 0) return process.exit(await runCli(args, DATA_DIR));

  const authSetup = await setupAuth(process.env, IS_PROD, DATA_DIR);
  for (const m of authSetup.messages) console.warn(m);
  if (authSetup.error) {
    console.error(authSetup.error);
    process.exit(1);
  }

  // Ensure sample data exists on launch
  ensureSampleData(DATA_DIR);

  const { app, sweep } = createApp({
    dataDir: DATA_DIR,
    distDir: IS_PROD ? path.join(process.cwd(), 'dist') : undefined,
    auth: authSetup.store,
    overlandToken: process.env.OVERLAND_TOKEN || undefined,
    seed: process.env.SEED_SAMPLE_DATA === 'true',
    csp: IS_PROD,
    tileCacheDir: IS_PROD ? path.join(process.cwd(), 'cache', 'tiles') : undefined,
  });
  setInterval(sweep, 60_000).unref();

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

main();
