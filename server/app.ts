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
import { basicAuth } from './auth.ts';
import { clientKey, rateLimit, TokenBuckets } from './rateLimit.ts';
import { sendJson, serveStatic } from './staticFiles.ts';
import { createTileProxy } from './tileProxy.ts';
import type { TripsResponse } from '../shared/types.ts';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface AppOptions {
  dataDir: string;
  /** Serve this Vite build (prod). Without it, the caller adds the Vite dev middleware. */
  distDir?: string;
  /** Basic auth credentials; without them nothing is protected (dev only) */
  auth?: { user: string; hash: string };
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
  // Wrong passwords: 1 per second, 10 in a burst (each costs an scrypt)
  const authFailures = new TokenBuckets(1, 10);

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

  // Location history is sensitive: everything below requires login
  if (opts.auth) {
    app.use(
      basicAuth({
        ...opts.auth,
        allowAttempt: (req) => authFailures.has(clientKey(req)),
        onFailure: (req) => authFailures.take(clientKey(req)),
      }),
    );
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
      authFailures.sweep();
    },
  };
}
