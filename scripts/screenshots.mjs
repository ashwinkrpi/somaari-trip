// Retakes the guide screenshots in docs/images/ from generated sample data.
// Usage: npm run screenshots (builds first). Needs Chromium (CHROMIUM=/path to override).
//
// Runs the production build (dist/) from a temp dir with SEED_SAMPLE_DATA=true, so it only ever
// sees sample data and a temp tile cache, never ./data or DATA_DIR. Login is a throwaway random
// password. Drives headless Chromium over the DevTools protocol with Node's built-in WebSocket.
import { spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'docs', 'images');
const CHROMIUM = process.env.CHROMIUM || 'chromium';
const JPEG_QUALITY = 85;

// The badge isn't shown on somaari.in screenshots (the site never mentions self-hosting)
const HIDE_CSS = '#somaari-trip-sidebar h1 > span { display: none !important; }';

const DESKTOP = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };

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

/** Minimal DevTools protocol client for one page target */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('DevTools connection failed'));
  });
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const p = msg.id && pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
    else p.resolve(msg.result);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject, method });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { send, close: () => ws.close() };
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

    const profile = path.join(tmp, 'chromium');
    children.push(
      spawn(
        CHROMIUM,
        [
          '--headless=new',
          '--remote-debugging-port=0',
          `--user-data-dir=${profile}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--hide-scrollbars',
          '--mute-audio',
          'about:blank',
        ],
        { stdio: 'ignore' },
      ),
    );
    const devtoolsPort = await waitFor(
      () => fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0],
      'Chromium',
    );
    const target = await waitFor(async () => {
      const list = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json();
      return list.find((t) => t.type === 'page');
    }, 'a Chromium page');
    const cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setExtraHTTPHeaders', { headers: { Authorization: authHeader } });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `document.addEventListener('DOMContentLoaded', () => {
        const s = document.createElement('style');
        s.textContent = ${JSON.stringify(HIDE_CSS)};
        document.head.appendChild(s);
      });`,
    });

    const evaluate = async (expression) => {
      const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (exceptionDetails) throw new Error(`Page error: ${exceptionDetails.text}`);
      return result.value;
    };

    /** Waits until the map has finished moving and every visible tile has loaded */
    const settle = async () => {
      await sleep(1200);
      await waitFor(
        () =>
          evaluate(`(() => {
            const tiles = [...document.querySelectorAll('.leaflet-tile-container img')];
            return tiles.length > 0 && tiles.every(t => t.complete && t.classList.contains('leaflet-tile-loaded'))
              && !document.querySelector('.leaflet-zoom-anim');
          })()`),
        'map tiles',
      );
      await sleep(600);
    };

    const load = async (viewport) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', viewport);
      await cdp.send('Page.navigate', { url: `${base}/` });
      await waitFor(() => evaluate(`document.querySelectorAll('#somaari-trip-sidebar button').length > 6`), 'the app');
      // The newest day is selected and drawn once the days list loads
      await waitFor(() => evaluate(`!!document.querySelector('#leaflet-map-canvas canvas')`), 'routes');
      await settle();
    };

    /** Clicks the centre of the first element matching selector whose text matches pattern */
    const click = async (selector, pattern = '') => {
      const rect = await evaluate(`(() => {
        const re = new RegExp(${JSON.stringify(pattern)}, 'i');
        const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => re.test(e.textContent ?? ''));
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (!rect) throw new Error(`Nothing to click: ${selector} /${pattern}/`);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
      }
      await sleep(300);
    };

    const shoot = async (name) => {
      // Move the pointer off the controls so no hover state shows
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
      await sleep(200);
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: JPEG_QUALITY });
      fs.writeFileSync(path.join(OUT_DIR, `${name}.jpg`), Buffer.from(data, 'base64'));
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
    await evaluate(`(() => {
      const map = document.querySelector('#leaflet-map-canvas').getBoundingClientRect();
      const inView = [...document.querySelectorAll('.custom-stop-icon')].find(m => {
        const r = m.getBoundingClientRect();
        return r.left > map.left && r.right < map.right && r.top > map.top && r.bottom < map.bottom;
      });
      if (!inView) throw new Error('no stop marker in view');
      inView.setAttribute('data-shot-target', '');
    })()`);
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

    cdp.close();
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
