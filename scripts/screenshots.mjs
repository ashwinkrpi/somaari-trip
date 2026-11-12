// Retakes the guide screenshots in docs/images/ from generated sample data.
// Usage: npm run screenshots (builds first). Needs Chromium (CHROMIUM=/path to override).
//
// Runs the production build (dist/) from a temp dir with SEED_SAMPLE_DATA=true, so it only ever
// sees sample data and a temp tile cache, never ./data or DATA_DIR. Login is a throwaway random
// password. Drives the system Chromium with playwright-core (no browser download).
import { spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'docs', 'images');
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
const JPEG_QUALITY = 85;

// The badge isn't shown on somaari.in screenshots (the site never mentions self-hosting)
const HIDE_CSS = '#somaari-trip-sidebar h1 > span { display: none !important; }';

const DESKTOP = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, isMobile: false };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(check, what, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await check();
      if (v) return v;
    } catch {
      // Not ready yet
    }
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(200);
  }
}

function startServer(tmp, port, authUser, authHash) {
  fs.symlinkSync(path.join(ROOT, 'dist'), path.join(tmp, 'dist'));
  // A minimal env: nothing from the caller's shell (DATA_DIR, OVERLAND_TOKEN, ...) reaches it
  const server = spawn(process.execPath, [path.join(ROOT, 'dist', 'server.cjs')], {
    cwd: tmp,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      PORT: String(port),
      AUTH_USER: authUser,
      AUTH_HASH: authHash,
      SEED_SAMPLE_DATA: 'true',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  return server;
}

function hashPassword(user, password) {
  const res = spawnSync(path.join(ROOT, 'node_modules', '.bin', 'tsx'), ['scripts/hash-password.ts', user], {
    cwd: ROOT,
    input: `${password}\n`,
    encoding: 'utf8',
  });
  const hash = /^AUTH_HASH=(.+)$/m.exec(res.stdout ?? '')?.[1];
  if (res.status !== 0 || !hash) throw new Error(`hash-password failed: ${res.stderr}`);
  return hash;
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'server.cjs'))) {
    throw new Error('dist/ is missing: run npm run build first');
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'somaari-trip-shots-'));
  const children = [];
  const cleanup = () => {
    for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });

  try {
    const user = 'demo';
    const password = crypto.randomBytes(18).toString('base64url');
    const authHeader = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;

    children.push(startServer(tmp, port, user, hashPassword(user, password)));
    await waitFor(async () => (await fetch(`${base}/api/health`)).ok, 'the server');

    const browser = await chromium.launch({ executablePath: CHROMIUM });
    let page;

    /** Waits until the map has finished moving and every visible tile has loaded */
    const settle = async () => {
      await sleep(1200);
      await page.waitForFunction(() => {
        const tiles = [...document.querySelectorAll('.leaflet-tile-container img')];
        return tiles.length > 0 && tiles.every((t) => t.complete && t.classList.contains('leaflet-tile-loaded'))
          && !document.querySelector('.leaflet-zoom-anim');
      }, null, { timeout: 30_000 });
      await sleep(600);
    };

    /** A fresh page at this viewport, signed in, with the app loaded and the map settled */
    const load = async (device) => {
      await page?.context().close();
      const context = await browser.newContext({ ...device, extraHTTPHeaders: { Authorization: authHeader } });
      await context.addInitScript((css) => {
        document.addEventListener('DOMContentLoaded', () => {
          const s = document.createElement('style');
          s.textContent = css;
          document.head.appendChild(s);
        });
      }, HIDE_CSS);
      page = await context.newPage();
      await page.goto(`${base}/`);
      await page.waitForFunction(() => document.querySelectorAll('#somaari-trip-sidebar button').length > 6);
      // The newest day is selected and drawn once the days list loads
      await page.locator('#leaflet-map-canvas canvas').first().waitFor();
      await settle();
    };

    /** Clicks the first element matching selector whose text matches pattern */
    const click = async (selector, pattern = '') => {
      await page.locator(selector).filter({ hasText: new RegExp(pattern, 'i') }).first().click({ timeout: 10_000 });
      await sleep(300);
    };

    const shoot = async (name) => {
      // Move the pointer off the controls so no hover state shows
      await page.mouse.move(0, 0);
      await sleep(200);
      await page.screenshot({ path: path.join(OUT_DIR, `${name}.jpg`), type: 'jpeg', quality: JPEG_QUALITY });
      console.log(`docs/images/${name}.jpg`);
    };

    const sidebarTab = (label) => click('#somaari-trip-sidebar button', `^${label}`);

    // Desktop
    await load(DESKTOP);
    await shoot('overview');

    await load(DESKTOP);
    await click('#somaari-trip-sidebar button', '^Date Range$');
    await click('#somaari-trip-sidebar button', '^All Days');
    await settle();
    await shoot('date-range');

    await load(DESKTOP);
    await sidebarTab('Trips');
    await click('#somaari-trip-sidebar div.cursor-pointer', 'driving');
    await settle();
    await shoot('trips');

    // Zoomed to the driving trip with nothing selected, then one stop's popup
    await click('#somaari-trip-sidebar div.cursor-pointer', 'driving');
    await sleep(300);
    await page.evaluate(() => {
      const map = document.querySelector('#leaflet-map-canvas').getBoundingClientRect();
      const inView = [...document.querySelectorAll('.custom-stop-icon')].find((m) => {
        const r = m.getBoundingClientRect();
        return r.left > map.left && r.right < map.right && r.top > map.top && r.bottom < map.bottom;
      });
      if (!inView) throw new Error('no stop marker in view');
      inView.setAttribute('data-shot-target', '');
    });
    await click('[data-shot-target]');
    await settle();
    await shoot('stop-popup');

    await load(DESKTOP);
    await sidebarTab('Display');
    await click('#somaari-trip-sidebar button', '^By Speed');
    await settle();
    await shoot('speed');

    // Phone
    await load(PHONE);
    await shoot('phone-map');

    await load(PHONE);
    await click('button[title="Toggle Menu"]');
    await sleep(500);
    await shoot('phone-menu');

    await browser.close();
  } finally {
    cleanup();
    await sleep(500);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
