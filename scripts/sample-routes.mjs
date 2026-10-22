// Fetches the road geometry for the sample data (server/seedData.ts) and writes
// server/sampleRoutes.ts. Usage: node scripts/sample-routes.mjs (needs internet).
//
// Run it only when the waypoints below change: the generated file is committed, so the app never
// needs the network to seed sample data. Routes come from the OSRM servers at
// routing.openstreetmap.de (car, bike and foot profiles, OpenStreetMap data); one request each.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'server', 'sampleRoutes.ts');
const PROFILE_URL = {
  car: 'https://routing.openstreetmap.de/routed-car/route/v1/driving',
  bike: 'https://routing.openstreetmap.de/routed-bike/route/v1/driving',
  foot: 'https://routing.openstreetmap.de/routed-foot/route/v1/driving',
};

// Bengaluru: home in Koramangala, office in Indiranagar. [lat, lon]
const HOME = [12.9352, 77.6245];
const OFFICE = [12.9716, 77.6412];

// One route per sample trip, keyed by trip and day index (0-5, 2026-08-25 to 2026-08-30).
// `stop` is the waypoint where the trip pauses (signal, park); seedData picks a point otherwise.
const ROUTES = {
  'morning-0': { profile: 'car', points: [HOME, OFFICE] },
  'morning-1': { profile: 'bike', points: [HOME, [12.9530, 77.6300], OFFICE] },
  'morning-2': { profile: 'car', points: [HOME, [12.9430, 77.6270], OFFICE] },
  'morning-3': { profile: 'bike', points: [HOME, [12.9430, 77.6270], OFFICE] },
  'morning-4': { profile: 'car', points: [HOME, [12.9620, 77.6360], OFFICE] },
  'morning-5': { profile: 'bike', points: [HOME, [12.9480, 77.6230], OFFICE] },
  'lunch-0': { profile: 'foot', points: [OFFICE, [12.9735, 77.6405]] },
  'lunch-1': { profile: 'foot', points: [OFFICE, [12.9700, 77.6420]] },
  'lunch-2': { profile: 'foot', points: [OFFICE, [12.9725, 77.6435]] },
  'lunch-3': { profile: 'foot', points: [OFFICE, [12.9705, 77.6395]] },
  'lunch-4': { profile: 'foot', points: [OFFICE, [12.9690, 77.6410]] },
  'lunch-5': { profile: 'foot', points: [OFFICE, [12.9740, 77.6420]] },
  // Evening: running loops from home, cycling via Cubbon Park, driving home
  'evening-0': { profile: 'foot', points: [HOME, [12.9290, 77.6330], [12.9230, 77.6420], HOME], stop: 2 },
  'evening-1': { profile: 'bike', points: [OFFICE, [12.9745, 77.5955], HOME], stop: 1 },
  'evening-2': { profile: 'car', points: [OFFICE, HOME] },
  'evening-3': { profile: 'foot', points: [HOME, [12.9330, 77.6150], [12.9290, 77.6260], HOME], stop: 1 },
  'evening-4': { profile: 'bike', points: [OFFICE, [12.9817, 77.6200], [12.9745, 77.5955], HOME], stop: 2 },
  'evening-5': { profile: 'car', points: [OFFICE, [12.9430, 77.6270], HOME] },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const metres = (a, b) => {
  const rad = Math.PI / 180;
  const x = (b[1] - a[1]) * rad * Math.cos(((a[0] + b[0]) / 2) * rad);
  return Math.hypot(x, (b[0] - a[0]) * rad) * 6371000;
};

/**
 * Cuts out-and-back spurs: OSRM drives up a side road to reach a waypoint that snapped off the
 * main road, then turns round. A real trip would just pass by. Removes everything between two
 * visits to the same spot (within 15 m) less than 600 m of road apart.
 */
function removeSpurs(line) {
  const out = [];
  for (const p of line) {
    let along = 0;
    for (let i = out.length - 1; i > 0 && along < 600; i--) {
      along += metres(out[i], out[i - 1]);
      if (metres(out[i - 1], p) < 15 && along > 30) {
        out.length = i - 1;
        break;
      }
    }
    out.push(p);
  }
  return out;
}

async function fetchRoute({ profile, points }) {
  const coords = points.map(([lat, lon]) => `${lon},${lat}`).join(';');
  const url = `${PROFILE_URL[profile]}/${coords}?overview=full&geometries=geojson&continue_straight=true`;
  const res = await fetch(url, { headers: { 'User-Agent': 'somaari-trip sample-routes script' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const body = await res.json();
  if (body.code !== 'Ok') throw new Error(`${body.code} ${url}`);
  return {
    line: body.routes[0].geometry.coordinates.map(([lon, lat]) => [+lat.toFixed(6), +lon.toFixed(6)]),
    waypoints: body.waypoints.map((w) => [w.location[1], w.location[0]]),
  };
}

const out = {};
for (const [key, route] of Object.entries(ROUTES)) {
  const { line, waypoints } = await fetchRoute(route);
  // Drop repeated vertices; they make zero-length steps
  const dedup = removeSpurs(line.filter((p, i) => i === 0 || p[0] !== line[i - 1][0] || p[1] !== line[i - 1][1]));
  const entry = { line: dedup };
  if (route.stop !== undefined) {
    const [wl, wn] = waypoints[route.stop];
    let best = 0;
    dedup.forEach(([lat, lon], i) => {
      const [bl, bn] = dedup[best];
      if ((lat - wl) ** 2 + (lon - wn) ** 2 < (bl - wl) ** 2 + (bn - wn) ** 2) best = i;
    });
    entry.stopIndex = best;
  }
  out[key] = entry;
  console.log(`${key}: ${dedup.length} points`);
  await sleep(1000); // be gentle with the public server
}

const header = `// Generated by scripts/sample-routes.mjs from OpenStreetMap data (routing.openstreetmap.de),
// © OpenStreetMap contributors, ODbL. Do not edit by hand. Road geometry for the sample trips in seedData.ts: [lat, lon] vertices.
`;
const body = Object.entries(out)
  .map(([key, { line, stopIndex }]) => {
    const stop = stopIndex === undefined ? '' : ` stopIndex: ${stopIndex},`;
    return `  '${key}': {${stop} line: ${JSON.stringify(line)} },`;
  })
  .join('\n');
fs.writeFileSync(
  OUT,
  `${header}export const SAMPLE_ROUTES: Record<string, { line: [number, number][]; stopIndex?: number }> = {\n${body}\n};\n`,
);
console.log(`Wrote ${path.relative(ROOT, OUT)}`);
