import fs from 'fs';
import path from 'path';
import { SAMPLE_ROUTES } from './sampleRoutes.ts';

export function ensureSampleData(dataDir: string) {
  if (process.env.SEED_SAMPLE_DATA !== 'true') {
    return; // No-op by default to prevent EROFS on read-only mount
  }

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const existingFiles = fs.readdirSync(dataDir).filter(f => f.startsWith('trips_') && f.endsWith('.csv'));
  if (existingFiles.length > 0) {
    return; // Already has data
  }

  console.log('Generating realistic sample Overland GPS trip data in ./data/...');
  generateSampleDays(dataDir);
}

type LatLon = [number, number];
type Mode = 'driving' | 'cycling' | 'running' | 'walking';

const HEADER = 'timestamp,trip_id,lat,lon,speed_mps,speed_accuracy,course,course_accuracy,altitude_m,vertical_accuracy,accuracy_m,battery_level,battery_state,motion,wifi_ssid,device_id,trip_distance_m,trip_mode,trip_start\n';

// Per mode: seconds between logged points, cruising speed (m/s) and its swing, speed through sharp turns
const MODES: Record<Mode, { dt: number; speed: number; swing: number; corner: number; motion: string }> = {
  driving: { dt: 3, speed: 8.5, swing: 4, corner: 4, motion: 'automotive' },
  cycling: { dt: 3, speed: 4.8, swing: 1.5, corner: 3, motion: 'cycling' },
  running: { dt: 5, speed: 3.2, swing: 0.6, corner: 2.6, motion: 'running' },
  walking: { dt: 5, speed: 1.4, swing: 0.15, corner: 1.2, motion: 'walking' },
};

const RAD = Math.PI / 180;

function metres(a: LatLon, b: LatLon): number {
  const x = (b[1] - a[1]) * RAD * Math.cos(((a[0] + b[0]) / 2) * RAD);
  return Math.hypot(x, (b[0] - a[0]) * RAD) * 6371000;
}

function bearing(a: LatLon, b: LatLon): number {
  const deg = Math.atan2((b[1] - a[1]) * Math.cos(a[0] * RAD), b[0] - a[0]) / RAD;
  return (deg + 360) % 360;
}

/** Small deterministic PRNG (mulberry32) so the sample data and screenshots are the same every run */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface RoutePoint {
  timeMs: number;
  lat: number;
  lon: number;
  speed: number;
  course: number;
  along: number; // metres from the start of the route
  stopped: boolean;
}

/**
 * Moves along a road polyline at the mode's speed, logging a point every `dt` seconds, so the
 * track follows the road. Slows for sharp turns. If `stop` is given, pauses there for `count`
 * stationary points `interval` seconds apart (a signal, a park bench).
 */
function travel(
  line: LatLon[],
  mode: Mode,
  startMs: number,
  stop?: { along: number; count: number; interval: number },
): RoutePoint[] {
  const { dt, speed, swing, corner } = MODES[mode];
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + metres(line[i - 1], line[i]));
  const total = cum[cum.length - 1];

  // Distances along the route of turns sharper than 50 degrees
  const turns: number[] = [];
  for (let i = 1; i < line.length - 1; i++) {
    let d = Math.abs(bearing(line[i - 1], line[i]) - bearing(line[i], line[i + 1]));
    if (d > 180) d = 360 - d;
    if (d > 50) turns.push(cum[i]);
  }

  let seg = 0;
  const at = (s: number) => {
    while (seg < line.length - 2 && cum[seg + 1] < s) seg++;
    const len = cum[seg + 1] - cum[seg];
    const f = len > 0 ? (s - cum[seg]) / len : 0;
    const [a, b] = [line[seg], line[seg + 1]];
    return { lat: a[0] + (b[0] - a[0]) * f, lon: a[1] + (b[1] - a[1]) * f, course: bearing(a, b) };
  };
  const speedAt = (s: number, t: number) => {
    const cruise = speed + Math.sin(t / 90) * swing;
    const nearTurn = turns.some(d => Math.abs(d - s) < 25);
    return nearTurn ? Math.min(cruise, corner) : cruise;
  };

  const points: RoutePoint[] = [];
  let s = 0;
  let t = 0;
  let stopDone = !stop;
  for (;;) {
    points.push({ timeMs: startMs + t * 1000, ...at(s), speed: speedAt(s, t), along: s, stopped: false });
    if (s >= total) break;
    if (stop && !stopDone && s >= stop.along) {
      stopDone = true;
      const here = at(s);
      for (let i = 1; i <= stop.count; i++) {
        points.push({ timeMs: startMs + (t + i * stop.interval) * 1000, ...here, speed: 0, along: s, stopped: true });
      }
      t += (stop.count + 1) * stop.interval;
      continue;
    }
    s = Math.min(total, s + speedAt(s, t) * dt);
    t += dt;
  }
  return points;
}

function routeLine(key: string): LatLon[] {
  const route = SAMPLE_ROUTES[key];
  if (!route) throw new Error(`No sample route ${key}`);
  return route.line;
}

/** Metres along a route to its stop: the route's stopIndex, else `fraction` of the way through its vertices */
function routeStop(key: string, fraction: number): number {
  const { line, stopIndex } = SAMPLE_ROUTES[key];
  const end = stopIndex ?? Math.round((line.length - 1) * fraction);
  let along = 0;
  for (let i = 1; i <= end; i++) along += metres(line[i - 1], line[i]);
  return along;
}

export function generateSampleDays(dataDir: string) {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Bengaluru, India: home in Koramangala, office in Indiranagar. Every trip follows real roads
  // (server/sampleRoutes.ts, generated from OpenStreetMap by scripts/sample-routes.mjs).
  // Days: 2026-08-25 to 2026-08-30

  const dates = [
    '2026-08-25',
    '2026-08-26',
    '2026-08-27',
    '2026-08-28',
    '2026-08-29',
    '2026-08-30',
  ];

  for (let dIdx = 0; dIdx < dates.length; dIdx++) {
    const dateStr = dates[dIdx];
    const day = dateStr.replace(/-/g, '');
    const random = seededRandom(Number(day));
    const rows: string[] = [];
    let battery = 0.95 - (dIdx * 0.02);

    const pushRow = (
      p: RoutePoint,
      tripId: string,
      mode: Mode,
      dist: number,
      opts: { speedAcc: number; courseAcc: number; vertAcc: number; motion: string; wifi: string; batteryState?: string; start: boolean },
    ) => {
      rows.push([
        new Date(p.timeMs).toISOString(),
        tripId,
        p.lat.toFixed(6),
        p.lon.toFixed(6),
        +p.speed.toFixed(2),
        opts.speedAcc,
        p.stopped ? 0 : Math.round(p.course),
        opts.courseAcc,
        915 + Math.round(Math.sin(p.along / 800) * 10),
        opts.vertAcc,
        5 + Math.round(random() * 7),
        +Math.max(0.1, battery).toFixed(2),
        opts.batteryState ?? 'unplugged',
        opts.motion,
        opts.wifi,
        'sample-device',
        Math.round(dist),
        mode,
        opts.start ? new Date(p.timeMs).toISOString() : '',
      ].join(','));
    };

    // Trip 1: Morning Commute home -> office (08:30 IST -> 03:00 UTC), driving or cycling,
    // with a stop at a signal partway
    const trip1Mode: Mode = dIdx % 2 === 0 ? 'driving' : 'cycling';
    const trip1Id = `trip_${day}_morning`;
    const trip1Key = `morning-${dIdx}`;
    const trip1 = travel(routeLine(trip1Key), trip1Mode, new Date(`${dateStr}T03:00:00.000Z`).getTime(),
      { along: routeStop(trip1Key, 0.45), count: 4, interval: 45 });
    trip1.forEach((p, i) => {
      battery -= 0.000025 * MODES[trip1Mode].dt;
      pushRow(p, trip1Id, trip1Mode, p.along, {
        speedAcc: 1.0, courseAcc: 5.0, vertAcc: 3.0,
        motion: p.stopped ? 'stationary' : MODES[trip1Mode].motion,
        wifi: i === 0 ? 'Home_Fiber_5G' : (p.stopped ? 'TrafficSignal_Mesh' : ''),
        start: i === 0,
      });
    });

    // Trip 2: Lunch walk from the office to a cafe, a stationary stop there, and the walk back
    // after a deliberate gap (> 5 min, so the trip splits into two segments)
    const trip2Id = `trip_${day}_lunch_walk`;
    const walkLine = routeLine(`lunch-${dIdx}`);
    const walkStyle = { speedAcc: 0.5, courseAcc: 3.0, vertAcc: 2.0, motion: 'walking' };
    const walkOut = travel(walkLine, 'walking', new Date(`${dateStr}T06:30:00.000Z`).getTime());
    walkOut.forEach((p, i) => {
      battery -= 0.0001;
      pushRow(p, trip2Id, 'walking', p.along, { ...walkStyle, wifi: '', start: i === 0 });
    });

    // Stationary stop at the cafe, charging
    const cafe = walkOut[walkOut.length - 1];
    const cafeStartTime = cafe.timeMs + 31 * 1000;
    for (let i = 0; i < 5; i++) {
      pushRow({ ...cafe, timeMs: cafeStartTime + i * 60 * 1000, speed: 0, stopped: true }, trip2Id, 'walking', cafe.along, {
        speedAcc: 0.1, courseAcc: 0, vertAcc: 2.0, motion: 'stationary', wifi: 'ThirdWaveCoffee_Guest',
        batteryState: 'charging', start: false,
      });
    }

    // Walk back the same way, 20 min after reaching the cafe
    const walkBack = travel([...walkLine].reverse(), 'walking', cafeStartTime + 20 * 60 * 1000);
    walkBack.forEach((p, i) => {
      pushRow(p, trip2Id, 'walking', cafe.along + p.along, {
        ...walkStyle, wifi: i === walkBack.length - 1 ? 'Office_Corp_WLAN' : '', start: false,
      });
    });

    // Trip 3: Evening Trip (18:30 IST -> 13:00 UTC): a run from home, a ride home via Cubbon Park,
    // or the drive home. Runs and rides stop for a break.
    const trip3Mode: Mode = dIdx % 3 === 0 ? 'running' : (dIdx % 3 === 1 ? 'cycling' : 'driving');
    const trip3Id = `trip_${day}_evening`;
    const trip3Key = `evening-${dIdx}`;
    const parkStop = trip3Mode !== 'driving' ? { along: routeStop(trip3Key, 0.5), count: 4, interval: 40 } : undefined;
    const parkWifi = trip3Mode === 'cycling' ? 'CubbonPark_FreeWifi' : 'BBMP_Park_WiFi';
    const trip3 = travel(routeLine(trip3Key), trip3Mode, new Date(`${dateStr}T13:00:00.000Z`).getTime(), parkStop);
    trip3.forEach((p, i) => {
      battery -= 0.0000375 * MODES[trip3Mode].dt;
      pushRow(p, trip3Id, trip3Mode, p.along, {
        speedAcc: 0.8, courseAcc: 4.0, vertAcc: 2.5,
        motion: p.stopped ? 'stationary' : MODES[trip3Mode].motion,
        wifi: p.stopped ? parkWifi : (i === trip3.length - 1 ? 'Home_Fiber_5G' : ''),
        start: i === 0,
      });
    });

    const csvContent = HEADER + rows.join('\n') + '\n';
    const filePath = path.join(dataDir, `trips_${dateStr}.csv`);
    fs.writeFileSync(filePath, csvContent, 'utf-8');
  }

  console.log(`Successfully generated ${dates.length} sample trip log files in ${dataDir}`);
}
