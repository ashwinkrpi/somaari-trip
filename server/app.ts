import crypto from 'crypto';
import express from 'express';
import {
  extractStops,
  buildTripFeatures,
  getAvailableDays,
  getLatestIstDay,
  loadPointsForIstRange,
  istDate,
} from './tripParser.ts';
import { appendDailyRows, overlandToDailyRows } from './overlandIngest.ts';
import { generateSampleDays } from './seedData.ts';
import { verifyPassword } from './auth.ts';
import type { AuthStore } from './authStore.ts';
import { clientKey, LoginLimiter, rateLimit, TokenBuckets } from './rateLimit.ts';
import {
  clearCookie,
  decodeSession,
  newSession,
  readCookie,
  renewal,
  sessionCookie,
} from './session.ts';
import { sendJson, serveStatic } from './staticFiles.ts';
import { createTileProxy } from './tileProxy.ts';
import type { SessionResponse, TripsResponse } from '../shared/types.ts';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface AppOptions {
  dataDir: string;
  /** Serve this Vite build (prod). Without it, the caller adds the Vite dev middleware. */
  distDir?: string;
  /** The login (auth.json). Without it nothing is protected (NO_LOGIN=true, or dev) */
  auth?: AuthStore;
  /** Wait after a wrong password (default 1000 ms) */
  loginFailureDelayMs?: number;
  /** Enables POST /api/overland */
  overlandToken?: string;
  /** Enables POST /api/seed */
  seed?: boolean;
  /** CSP blocks Vite's inline dev scripts, so it's only sent in production */
  csp?: boolean;
  /** Enables the /tiles/ proxy, caching tiles here (dev fetches tiles directly) */
  tileCacheDir?: string;
}

// Same headers nginx used to add
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), payment=(), usb=()',
};
const CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'";

export interface CreatedApp {
  app: express.Express;
  /** Drops idle rate-limit entries; call periodically */
  sweep: () => void;
}

export function createApp(opts: AppOptions): CreatedApp {
  const { dataDir } = opts;
  const app = express();
  app.disable('x-powered-by');

  const apiLimit = new TokenBuckets(10, 20);
  const overlandLimit = new TokenBuckets(2, 10);
  const loginLimit = new LoginLimiter();
  const failureDelayMs = opts.loginFailureDelayMs ?? 1000;

  app.use((req, res, next) => {
    res.set(SECURITY_HEADERS);
    if (opts.csp) res.set('Content-Security-Policy', CSP);
    next();
  });

  // Health endpoint (no auth, nothing sensitive)
  app.get('/api/health', rateLimit(apiLimit), (req, res) => {
    res.json({ status: 'ok', service: 'Somaari Trip Backend', time: new Date().toISOString() });
  });

  /**
   * POST /api/overland - Overland iOS batch upload, appended to the daily CSVs.
   * Only registered when overlandToken is set. Token via `Authorization: Bearer` or `?token=`
   * (the phone can't do basic auth). Replies only after the rows are on disk; any error
   * returns 500 so Overland retries the batch.
   */
  if (opts.overlandToken) {
    // Compare fixed-length digests so timingSafeEqual doesn't leak the token length
    const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest();
    const expected = sha256(opts.overlandToken);

    const requireToken: express.RequestHandler = (req, res, next) => {
      const auth = req.get('authorization');
      const bearer = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : undefined;
      const token = bearer ?? (typeof req.query.token === 'string' ? req.query.token : '');
      if (!crypto.timingSafeEqual(sha256(token), expected)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      next();
    };

    app.post(
      '/api/overland',
      rateLimit(overlandLimit),
      requireToken,
      express.json({ limit: '5mb' }),
      async (req, res) => {
        if (!Array.isArray(req.body?.locations)) {
          return res.status(400).json({ error: 'Expected a locations array' });
        }
        try {
          await appendDailyRows(dataDir, overlandToDailyRows(req.body));
          res.json({ result: 'ok' });
        } catch (err: any) {
          console.error('Error in /api/overland:', err);
          res.status(500).json({ error: 'Failed to write locations' });
        }
      },
    );
  }

  app.use('/api/', rateLimit(apiLimit));

  /**
   * Login. The page and its scripts load without one (they hold no data) and show the login
   * screen; /api/ and /tiles/ need a session cookie. A 401 here never sends WWW-Authenticate,
   * so the browser doesn't show its own sign-in popup.
   */
  const store = opts.auth;
  const nowSecs = () => Math.floor(Date.now() / 1000);

  /** Logged in (renewing an old browser session), or not */
  const checkSession = (req: express.Request, res: express.Response): boolean => {
    if (!store) return true;
    const secrets = store.get();
    const token = readCookie(req.get('cookie'));
    if (!secrets || !token) return false;
    const session = decodeSession(token, secrets.sessionSecret, nowSecs());
    if (!session) return false;
    const renewed = renewal(session, nowSecs());
    if (renewed) res.append('Set-Cookie', sessionCookie(renewed, secrets.sessionSecret));
    return true;
  };

  /** POSTs must be JSON (forces a CORS preflight cross-site) and, when sent, from this origin */
  const sameOrigin = (req: express.Request) => {
    if (!req.is('application/json')) return false;
    const origin = req.get('origin');
    if (!origin) return true;
    try {
      return new URL(origin).host === req.get('host');
    } catch {
      return false;
    }
  };

  app.get('/api/session', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const body: SessionResponse = store
      ? checkSession(req, res)
        ? { loginRequired: true, authenticated: true, user: store.get()?.user }
        : { loginRequired: true, authenticated: false }
      : { loginRequired: false, authenticated: true };
    res.json(body);
  });

  app.post('/api/login', express.json({ limit: '2kb' }), async (req, res) => {
    if (!store) return res.status(404).json({ error: 'Login is turned off' });
    if (!sameOrigin(req)) return res.status(403).json({ error: 'Forbidden' });
    const key = clientKey(req);
    const blockedMs = loginLimit.blockedFor(key);
    if (blockedMs > 0) {
      res.set('Retry-After', String(Math.ceil(blockedMs / 1000)));
      return res.status(429).json({ error: 'Too many wrong passwords. Try again in 15 minutes.' });
    }
    const secrets = store.get();
    if (!secrets) return res.status(503).json({ error: 'The login file is missing or broken; see the server log' });

    const { user, password, remember } = req.body ?? {};
    if (typeof user !== 'string' || typeof password !== 'string' || password.length > 1024) {
      return res.status(400).json({ error: 'Enter your user name and password' });
    }
    try {
      // Always run scrypt so a wrong user takes as long as a wrong password
      const passOk = await verifyPassword(password, secrets.parsedHash);
      const sha = (v: string) => crypto.createHash('sha256').update(v).digest();
      const userOk = crypto.timingSafeEqual(sha(user.trim()), sha(secrets.user));
      if (passOk && userOk) {
        loginLimit.succeed(key);
        const session = newSession(remember === true ? 'remember' : 'browser', nowSecs());
        res.set('Set-Cookie', sessionCookie(session, secrets.sessionSecret));
        return res.json({ ok: true });
      }
    } catch (err) {
      console.error('Error in /api/login:', err);
      return res.status(500).json({ error: 'Login failed' });
    }
    const nowBlocked = loginLimit.fail(key);
    await new Promise((r) => setTimeout(r, failureDelayMs));
    if (nowBlocked) {
      res.set('Retry-After', String(LoginLimiter.BLOCK_MS / 1000));
      return res.status(429).json({ error: 'Too many wrong passwords. Try again in 15 minutes.' });
    }
    res.status(401).json({ error: 'Wrong user name or password' });
  });

  app.post('/api/logout', express.json({ limit: '1kb' }), (req, res) => {
    if (!sameOrigin(req)) return res.status(403).json({ error: 'Forbidden' });
    res.set('Set-Cookie', clearCookie());
    res.json({ ok: true });
  });

  // Location history is sensitive: everything below on /api/ and /tiles/ needs a session
  if (store) {
    const requireSession: express.RequestHandler = (req, res, next) =>
      checkSession(req, res) ? next() : res.status(401).json({ error: 'Log in first' });
    app.use('/api/', requireSession);
    app.use('/tiles/', requireSession);
  }

  /**
   * 1. GET /api/days - List available dates with summary stats
   */
  app.get('/api/days', (req, res) => {
    try {
      const days = getAvailableDays(dataDir);
      sendJson(req, res, {
        success: true,
        count: days.length,
        days,
      });
    } catch (err: any) {
      console.error('Error fetching days:', err);
      res.status(500).json({ error: 'Failed to read trip days' });
    }
  });

  /**
   * 2. GET /api/trips - Query single date or range of dates (IST calendar days)
   * Params:
   *  - date: "YYYY-MM-DD"
   *  - from: "YYYY-MM-DD"
   *  - to: "YYYY-MM-DD"
   *  - max_accuracy: number (default 50)
   */
  app.get('/api/trips', (req, res) => {
    try {
      const singleDate = req.query.date as string | undefined;
      const fromDate = req.query.from as string | undefined;
      const toDate = req.query.to as string | undefined;
      const maxAccuracy = req.query.max_accuracy ? parseFloat(req.query.max_accuracy as string) : 50;

      // Dates are interpolated into file paths, so reject anything that isn't YYYY-MM-DD
      for (const d of [singleDate, fromDate, toDate]) {
        if (d !== undefined && (typeof d !== 'string' || !DATE_RE.test(d))) {
          return res.status(400).json({ error: 'Dates must be YYYY-MM-DD' });
        }
      }

      let from = singleDate ?? fromDate;
      let to = singleDate ?? toDate;
      if (!singleDate && !fromDate && !toDate) {
        // If neither specified, default to the latest available day
        from = to = getLatestIstDay(dataDir, maxAccuracy);
      }

      const allPoints = from || to ? loadPointsForIstRange(dataDir, from, to, maxAccuracy) : [];

      if (allPoints.length === 0) {
        const empty: TripsResponse = {
          type: 'FeatureCollection',
          features: [],
          stops: {
            type: 'FeatureCollection',
            features: [],
          },
          summary: {
            from: from || '',
            to: to || '',
            total_trips: 0,
            total_distance_m: 0,
            total_distance_km: 0,
            total_duration_s: 0,
            total_points: 0,
            total_stops: 0,
            modes: [],
            max_speed_kmh: 0,
            avg_speed_kmh: 0,
          },
        };
        return res.json(empty);
      }

      const tripFeatures = buildTripFeatures(allPoints);
      const stopFeatures = extractStops(allPoints);

      // Compute overall summary
      let total_distance_m = 0;
      let total_duration_s = 0;
      let max_speed_mps = 0;
      const modeSet = new Set<string>();

      for (const feat of tripFeatures) {
        total_distance_m += feat.properties.distance_m;
        total_duration_s += feat.properties.duration_s;
        max_speed_mps = Math.max(max_speed_mps, feat.properties.max_speed_mps);
        modeSet.add(feat.properties.trip_mode);
      }

      let movingSum = 0;
      let movingCount = 0;
      for (const p of allPoints) {
        if (p.speed_mps !== undefined && p.speed_mps > 0.5) {
          movingSum += p.speed_mps;
          movingCount++;
        }
      }
      const avg_speed_mps = movingCount > 0 ? movingSum / movingCount : 0;

      const response: TripsResponse = {
        type: 'FeatureCollection',
        features: tripFeatures,
        stops: {
          type: 'FeatureCollection',
          features: stopFeatures,
        },
        summary: {
          from: from ?? istDate(allPoints[0].timeMs),
          to: to ?? istDate(allPoints[allPoints.length - 1].timeMs),
          total_trips: tripFeatures.length,
          total_distance_m,
          total_distance_km: +(total_distance_m / 1000).toFixed(2),
          total_duration_s,
          total_points: allPoints.length,
          total_stops: stopFeatures.length,
          modes: Array.from(modeSet),
          max_speed_kmh: +(max_speed_mps * 3.6).toFixed(1),
          avg_speed_kmh: +(avg_speed_mps * 3.6).toFixed(1),
        },
      };
      sendJson(req, res, response);
    } catch (err: any) {
      console.error('Error in /api/trips:', err);
      res.status(500).json({ error: 'Failed to process trips' });
    }
  });

  /**
   * Regenerate sample data endpoint (overwrites fixed sample dates, so opt-in only)
   */
  if (opts.seed) {
    app.post('/api/seed', (req, res) => {
      try {
        generateSampleDays(dataDir);
        res.json({ success: true, message: 'Sample days generated successfully' });
      } catch (err: any) {
        console.error('Error in /api/seed:', err);
        res.status(500).json({ error: 'Failed to generate sample days' });
      }
    });
  }

  if (opts.tileCacheDir) {
    app.use('/tiles', createTileProxy({ cacheDir: opts.tileCacheDir }).handler);
  }

  if (opts.distDir) {
    // Unknown API paths are errors, not the SPA
    app.use('/api/', (req, res) => {
      res.status(404).json({ error: 'Not found' });
    });
    app.use(serveStatic(opts.distDir));
  }

  return {
    app,
    sweep: () => {
      apiLimit.sweep();
      overlandLimit.sweep();
      loginLimit.sweep();
    },
  };
}
