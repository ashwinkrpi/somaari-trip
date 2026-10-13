import fs from 'fs';
import path from 'path';
import Papa from 'papaparse';
import { formatDuration } from '../shared/format.ts';
import type { DaySummary, StopFeature, TripFeature, TripPoint, TripSegment } from '../shared/types.ts';

export interface RawCsvRow {
  timestamp?: string;
  trip_id?: string;
  lat?: string | number;
  lon?: string | number;
  speed_mps?: string | number;
  speed_accuracy?: string | number;
  course?: string | number;
  course_accuracy?: string | number;
  altitude_m?: string | number;
  vertical_accuracy?: string | number;
  accuracy_m?: string | number;
  battery_level?: string | number;
  battery_state?: string;
  motion?: string;
  wifi_ssid?: string;
  device_id?: string;
  trip_distance_m?: string | number;
  trip_mode?: string;
  trip_start?: string;
  [key: string]: any;
}

export interface ParsedPoint extends TripPoint {
  timeMs: number;
}

// Text columns stay strings: dynamic typing would turn timestamps into Dates and
// numeric-looking trip ids or SSIDs into numbers
const STRING_COLUMNS = new Set(['timestamp', 'trip_id', 'battery_state', 'motion', 'wifi_ssid', 'device_id', 'trip_mode', 'trip_start']);
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const FILE_RE = /^trips_(\d{4}-\d{2}-\d{2})\.csv$/i;

/** IST calendar date (YYYY-MM-DD) of a UTC epoch time */
export function istDate(timeMs: number): string {
  return new Date(timeMs + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Great-circle distance in meters */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3; // Earth radius in meters
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Parses a single CSV file content into strongly typed GPS points
 */
export function parseCsvPoints(csvContent: string, maxAccuracy = 50): ParsedPoint[] {
  const result = Papa.parse<RawCsvRow>(csvContent, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: (field) => !STRING_COLUMNS.has(String(field)),
  });

  const validPoints: ParsedPoint[] = [];

  for (const row of result.data) {
    if (!row.timestamp || row.lat === undefined || row.lon === undefined) continue;

    const lat = typeof row.lat === 'number' ? row.lat : parseFloat(row.lat);
    const lon = typeof row.lon === 'number' ? row.lon : parseFloat(row.lon);

    if (isNaN(lat) || isNaN(lon)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;

    const accuracy_m = typeof row.accuracy_m === 'number' ? row.accuracy_m : parseFloat(row.accuracy_m || '0');
    // Drop points where accuracy_m > maxAccuracy
    if (!isNaN(accuracy_m) && accuracy_m > maxAccuracy) continue;

    // Overland reports speed=-1 when unknown; keep that as undefined rather than 0 (stationary)
    const rawSpeed = typeof row.speed_mps === 'number' ? row.speed_mps : parseFloat(String(row.speed_mps ?? ''));
    const speed_mps = isNaN(rawSpeed) || rawSpeed < 0 ? undefined : +rawSpeed.toFixed(2);
    const speed_kmh = speed_mps === undefined ? undefined : +(speed_mps * 3.6).toFixed(1);
    const timeMs = new Date(row.timestamp).getTime();

    if (isNaN(timeMs)) continue;

    const trip_distance_m = typeof row.trip_distance_m === 'number' ? row.trip_distance_m : parseFloat(row.trip_distance_m || '0') || 0;
    const trip_mode = (row.trip_mode || 'unknown').toString().trim().toLowerCase();
    const trip_id = (row.trip_id || 'default_trip').toString().trim();

    validPoints.push({
      timestamp: row.timestamp,
      timeMs,
      trip_id,
      lat,
      lon,
      speed_mps,
      speed_kmh,
      speed_accuracy: typeof row.speed_accuracy === 'number' ? row.speed_accuracy : undefined,
      course: typeof row.course === 'number' ? row.course : undefined,
      course_accuracy: typeof row.course_accuracy === 'number' ? row.course_accuracy : undefined,
      altitude_m: typeof row.altitude_m === 'number' ? row.altitude_m : undefined,
      vertical_accuracy: typeof row.vertical_accuracy === 'number' ? row.vertical_accuracy : undefined,
      accuracy_m: isNaN(accuracy_m) ? 10 : +accuracy_m.toFixed(1),
      battery_level: typeof row.battery_level === 'number' ? row.battery_level : undefined,
      battery_state: row.battery_state,
      motion: (row.motion || '').toString(),
      wifi_ssid: row.wifi_ssid,
      device_id: row.device_id,
      trip_distance_m,
      trip_mode: trip_mode || 'unknown',
      trip_start: row.trip_start,
    });
  }

  // Sort chronologically
  validPoints.sort((a, b) => a.timeMs - b.timeMs);
  return validPoints;
}

/**
 * Detect stops: where motion contains "stationary" for 3+ consecutive points
 */
export function extractStops(points: ParsedPoint[]): StopFeature[] {
  const stops: StopFeature[] = [];
  let currentGroup: ParsedPoint[] = [];

  const flushGroup = () => {
    if (currentGroup.length >= 3) {
      const first = currentGroup[0];
      const last = currentGroup[currentGroup.length - 1];
      const duration_s = Math.max(0, Math.round((last.timeMs - first.timeMs) / 1000));
      
      // Calculate centroid
      const avgLat = currentGroup.reduce((acc, p) => acc + p.lat, 0) / currentGroup.length;
      const avgLon = currentGroup.reduce((acc, p) => acc + p.lon, 0) / currentGroup.length;
      const avgBattery = currentGroup.find(p => p.battery_level !== undefined)?.battery_level;
      const wifi = currentGroup.find(p => p.wifi_ssid)?.wifi_ssid;

      stops.push({
        type: 'Feature',
        id: `stop-${first.trip_id}-${first.timeMs}`,
        properties: {
          id: `stop-${first.trip_id}-${first.timeMs}`,
          trip_id: first.trip_id,
          trip_mode: first.trip_mode,
          start_time: first.timestamp,
          end_time: last.timestamp,
          duration_s,
          duration_formatted: formatDuration(duration_s),
          point_count: currentGroup.length,
          wifi_ssid: wifi,
          battery_level: avgBattery,
          motion: 'stationary',
          lat: +avgLat.toFixed(6),
          lon: +avgLon.toFixed(6),
        },
        geometry: {
          type: 'Point',
          coordinates: [+avgLon.toFixed(6), +avgLat.toFixed(6)],
        },
      });
    }
    currentGroup = [];
  };

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const isStationary = 
      (p.motion && p.motion.toLowerCase().includes('stationary')) ||
      (p.speed_mps === 0 && p.accuracy_m <= 30);

    if (isStationary) {
      // Check if continuing same trip and time gap is reasonable (< 15 mins)
      if (
        currentGroup.length > 0 &&
        (currentGroup[0].trip_id !== p.trip_id || (p.timeMs - currentGroup[currentGroup.length - 1].timeMs) > 900000)
      ) {
        flushGroup();
      }
      currentGroup.push(p);
    } else {
      flushGroup();
    }
  }
  flushGroup();

  return stops;
}

/**
 * Form GeoJSON LineStrings from points, splitting trips on > 5 min gaps (300s)
 */
export function buildTripFeatures(points: ParsedPoint[]): TripFeature[] {
  const tripsById: Record<string, ParsedPoint[]> = {};
  for (const pt of points) {
    if (!tripsById[pt.trip_id]) {
      tripsById[pt.trip_id] = [];
    }
    tripsById[pt.trip_id].push(pt);
  }

  const features: TripFeature[] = [];

  for (const [trip_id, tripPoints] of Object.entries(tripsById)) {
    if (tripPoints.length === 0) continue;

    tripPoints.sort((a, b) => a.timeMs - b.timeMs);

    const segments: TripSegment[] = [];
    let currentSegment: TripSegment = { points: [] };

    const GAP_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

    for (let i = 0; i < tripPoints.length; i++) {
      const pt = tripPoints[i];
      if (i > 0) {
        const timeDiff = pt.timeMs - tripPoints[i - 1].timeMs;
        if (timeDiff > GAP_THRESHOLD_MS) {
          // Break segment
          if (currentSegment.points.length > 0) {
            segments.push(currentSegment);
          }
          currentSegment = { points: [] };
        }
      }

      currentSegment.points.push({
        lat: pt.lat,
        lon: pt.lon,
        speed_mps: pt.speed_mps,
        timestamp: pt.timestamp,
      });
    }

    if (currentSegment.points.length > 0) {
      segments.push(currentSegment);
    }

    const firstPt = tripPoints[0];
    const lastPt = tripPoints[tripPoints.length - 1];
    const duration_s = Math.max(0, Math.round((lastPt.timeMs - firstPt.timeMs) / 1000));
    
    // trip_distance_m is cumulative, so the distance covered by these points is max - min.
    // This keeps a trip that spans IST midnight from being counted in full on both days.
    let minDist = Infinity;
    let maxDist = 0;
    for (const p of tripPoints) {
      if (p.trip_distance_m < minDist) minDist = p.trip_distance_m;
      if (p.trip_distance_m > maxDist) maxDist = p.trip_distance_m;
    }
    let distance_m = maxDist - minDist;
    if (maxDist === 0 && tripPoints.length > 1) {
      distance_m = 0;
      for (let j = 1; j < tripPoints.length; j++) {
        const p1 = tripPoints[j - 1];
        const p2 = tripPoints[j];
        distance_m += haversineMeters(p1.lat, p1.lon, p2.lat, p2.lon);
      }
    }

    // Unknown speeds are excluded from averages and max
    const knownSpeeds: number[] = [];
    for (const p of tripPoints) {
      if (p.speed_mps !== undefined) knownSpeeds.push(p.speed_mps);
    }
    const movingSpeeds = knownSpeeds.filter(v => v > 0.5);
    const avgOf = (vals: number[]) => (vals.length > 0 ? vals.reduce((acc, v) => acc + v, 0) / vals.length : 0);
    const avg_speed_mps = +avgOf(movingSpeeds.length > 0 ? movingSpeeds : knownSpeeds).toFixed(2);

    let max_speed_mps = 0;
    for (const v of knownSpeeds) {
      if (v > max_speed_mps) max_speed_mps = v;
    }

    // Majority mode
    const modeCounts: Record<string, number> = {};
    for (const p of tripPoints) {
      modeCounts[p.trip_mode] = (modeCounts[p.trip_mode] || 0) + 1;
    }
    const dominantMode = Object.entries(modeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || firstPt.trip_mode || 'unknown';

    features.push({
      type: 'Feature',
      id: trip_id,
      properties: {
        trip_id,
        trip_mode: dominantMode,
        start_time: firstPt.timestamp,
        end_time: lastPt.timestamp,
        duration_s,
        distance_m: Math.round(distance_m),
        distance_km: +(distance_m / 1000).toFixed(2),
        avg_speed_mps,
        avg_speed_kmh: +(avg_speed_mps * 3.6).toFixed(1),
        max_speed_mps: +max_speed_mps.toFixed(2),
        max_speed_kmh: +(max_speed_mps * 3.6).toFixed(1),
        point_count: tripPoints.length,
        battery_start: firstPt.battery_level,
        battery_end: lastPt.battery_level,
        segments_count: segments.length,
      },
      segments,
    });
  }

  // Sort trips by start_time
  features.sort((a, b) => new Date(a.properties.start_time).getTime() - new Date(b.properties.start_time).getTime());

  return features;
}

interface TripFile {
  date: string;
  filePath: string;
  mtimeMs: number;
  size: number;
}

function listTripFiles(dataDir: string): TripFile[] {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    return [];
  }
  const files: TripFile[] = [];
  for (const file of fs.readdirSync(dataDir)) {
    const match = file.match(FILE_RE);
    if (!match) continue;
    const filePath = path.join(dataDir, file);
    try {
      const stat = fs.statSync(filePath);
      files.push({ date: match[1], filePath, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch (err) {
      console.error(`Error reading ${filePath}:`, err);
    }
  }
  return files.sort((a, b) => a.date.localeCompare(b.date));
}

// Parsed points per file, invalidated when mtime or size changes. Points are parsed with no
// accuracy cutoff and filtered per request, so the accuracy slider doesn't re-parse anything.
// Cached points are shared between requests and must not be mutated.
// LRU (Map keeps insertion order; a hit moves the file to the end), capped by total points
// so memory stays bounded however much history there is. ~100k points is ~25 days.
let maxCachedPoints = 100_000;
const parseCache = new Map<string, { mtimeMs: number; size: number; points: ParsedPoint[] }>();
let cachedPointCount = 0;

function dropFromParseCache(filePath: string) {
  const entry = parseCache.get(filePath);
  if (!entry) return;
  cachedPointCount -= entry.points.length;
  parseCache.delete(filePath);
}

/** Parsed points of a file. With `cache: false` a miss is parsed but not kept (hits are still used). */
function readTripFile(file: TripFile, { cache = true } = {}): ParsedPoint[] {
  const cached = parseCache.get(file.filePath);
  if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) {
    parseCache.delete(file.filePath);
    parseCache.set(file.filePath, cached);
    return cached.points;
  }
  dropFromParseCache(file.filePath);
  const points = parseCsvPoints(fs.readFileSync(file.filePath, 'utf-8'), Infinity);
  if (cache && points.length <= maxCachedPoints) {
    parseCache.set(file.filePath, { mtimeMs: file.mtimeMs, size: file.size, points });
    cachedPointCount += points.length;
    for (const key of parseCache.keys()) {
      if (cachedPointCount <= maxCachedPoints) break;
      dropFromParseCache(key);
    }
  }
  return points;
}

/** For tests: empty the parse cache and set its cap */
export function resetParseCache(maxPoints = 100_000) {
  parseCache.clear();
  cachedPointCount = 0;
  maxCachedPoints = maxPoints;
}

/** For tests: number of points the parse cache holds */
export function parseCachePointCount(): number {
  return cachedPointCount;
}

/**
 * Load points whose IST date falls in [fromIst, toIst] (either bound optional).
 * Files are named by the IST date of their points, so only files in [fromIst, toIst] are read.
 * Points are still filtered by their own IST date, in case a file holds a stray row.
 */
export function loadPointsForIstRange(
  dataDir: string,
  fromIst: string | undefined,
  toIst: string | undefined,
  maxAccuracy = 50
): ParsedPoint[] {
  const points: ParsedPoint[] = [];

  for (const file of listTripFiles(dataDir)) {
    if ((fromIst && file.date < fromIst) || (toIst && file.date > toIst)) continue;
    try {
      for (const p of readTripFile(file)) {
        if (p.accuracy_m > maxAccuracy) continue;
        const d = istDate(p.timeMs);
        if ((!fromIst || d >= fromIst) && (!toIst || d <= toIst)) points.push(p);
      }
    } catch (err) {
      console.error(`Error reading ${file.filePath}:`, err);
    }
  }

  points.sort((a, b) => a.timeMs - b.timeMs);
  return points;
}

/**
 * Latest IST day with data, reading only the newest file(s) rather than summarising every day.
 */
export function getLatestIstDay(dataDir: string, maxAccuracy = 50): string | undefined {
  const files = listTripFiles(dataDir);
  for (let i = files.length - 1; i >= 0; i--) {
    try {
      let latest = -Infinity;
      for (const p of readTripFile(files[i])) {
        if (p.accuracy_m <= maxAccuracy && p.timeMs > latest) latest = p.timeMs;
      }
      if (latest > -Infinity) return istDate(latest);
    } catch (err) {
      console.error(`Error reading ${files[i].filePath}:`, err);
    }
  }
  return undefined;
}

function summariseDay(date: string, points: ParsedPoint[]): DaySummary {
  const trips = buildTripFeatures(points);
  let total_distance_m = 0;
  let duration_s = 0;
  const modes = new Set<string>();
  for (const t of trips) {
    total_distance_m += t.properties.distance_m;
    duration_s += t.properties.duration_s;
    modes.add(t.properties.trip_mode);
  }

  return {
    date,
    point_count: points.length,
    total_distance_m,
    total_distance_km: +(total_distance_m / 1000).toFixed(2),
    duration_s,
    trip_count: trips.length,
    modes: Array.from(modes),
    stops_count: extractStops(points).length,
  };
}

/** A file's points within the accuracy cutoff, grouped by their own IST day. Doesn't fill the parse cache. */
function fileDayPoints(file: TripFile, maxAccuracy: number): Map<string, ParsedPoint[]> {
  const byDay = new Map<string, ParsedPoint[]>();
  for (const p of readTripFile(file, { cache: false })) {
    if (p.accuracy_m > maxAccuracy) continue;
    const d = istDate(p.timeMs);
    let dayPoints = byDay.get(d);
    if (!dayPoints) byDay.set(d, (dayPoints = []));
    dayPoints.push(p);
  }
  return byDay;
}

// Summary of each IST day a file's points fall on, invalidated when mtime or size changes.
// A few hundred bytes per file, so kept for every file: /api/days re-parses only changed files.
const summaryCache = new Map<string, { mtimeMs: number; size: number; maxAccuracy: number; days: Map<string, DaySummary> }>();

/**
 * Summarise every IST day in the data directory. Uses the same trip/stop logic and
 * default accuracy as /api/trips so the sidebar numbers match the map view.
 */
export function getAvailableDays(dataDir: string, maxAccuracy = 50): DaySummary[] {
  const files = listTripFiles(dataDir);
  const live = new Set(files.map(f => f.filePath));
  for (const key of parseCache.keys()) if (!live.has(key)) dropFromParseCache(key);
  for (const key of summaryCache.keys()) if (!live.has(key)) summaryCache.delete(key);

  // Files holding points of each day; normally one, since files are named by IST date
  const filesByDay = new Map<string, TripFile[]>();
  for (const file of files) {
    let entry = summaryCache.get(file.filePath);
    if (!entry || entry.mtimeMs !== file.mtimeMs || entry.size !== file.size || entry.maxAccuracy !== maxAccuracy) {
      try {
        const days = new Map<string, DaySummary>();
        for (const [date, points] of fileDayPoints(file, maxAccuracy)) days.set(date, summariseDay(date, points));
        entry = { mtimeMs: file.mtimeMs, size: file.size, maxAccuracy, days };
        summaryCache.set(file.filePath, entry);
      } catch (err) {
        console.error(`Error reading ${file.filePath}:`, err);
        continue;
      }
    }
    for (const date of entry.days.keys()) {
      let dayFiles = filesByDay.get(date);
      if (!dayFiles) filesByDay.set(date, (dayFiles = []));
      dayFiles.push(file);
    }
  }

  const days: DaySummary[] = [];
  for (const [date, dayFiles] of filesByDay) {
    if (dayFiles.length === 1) {
      days.push(summaryCache.get(dayFiles[0].filePath)!.days.get(date)!);
      continue;
    }
    // A day split across files (a stray row in another file): summarise all its points together
    const points: ParsedPoint[] = [];
    for (const file of dayFiles) {
      try {
        for (const p of fileDayPoints(file, maxAccuracy).get(date) ?? []) points.push(p);
      } catch (err) {
        console.error(`Error reading ${file.filePath}:`, err);
      }
    }
    points.sort((a, b) => a.timeMs - b.timeMs);
    days.push(summariseDay(date, points));
  }

  // Sort latest date first
  days.sort((a, b) => b.date.localeCompare(a.date));
  return days;
}
