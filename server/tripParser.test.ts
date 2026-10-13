import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildTripFeatures,
  extractStops,
  getAvailableDays,
  loadPointsForIstRange,
  parseCachePointCount,
  parseCsvPoints,
  resetParseCache,
} from './tripParser.ts';

const HEADER = 'timestamp,trip_id,lat,lon,speed_mps,accuracy_m,motion,trip_distance_m,trip_mode';

type Row = {
  timestamp: string;
  trip_id?: string;
  lat?: number | string;
  lon?: number | string;
  speed_mps?: number | string;
  accuracy_m?: number | string;
  motion?: string;
  trip_distance_m?: number | string;
  trip_mode?: string;
};

function csv(rows: Row[]): string {
  const lines = rows.map(r =>
    [
      r.timestamp,
      r.trip_id ?? 't1',
      r.lat ?? 12.97,
      r.lon ?? 77.59,
      r.speed_mps ?? 5,
      r.accuracy_m ?? 10,
      r.motion ?? 'driving',
      r.trip_distance_m ?? 0,
      r.trip_mode ?? 'driving',
    ].join(',')
  );
  return [HEADER, ...lines].join('\n');
}

/** UTC ISO timestamp `mins` minutes after `start` */
function at(start: string, mins: number): string {
  return new Date(new Date(start).getTime() + mins * 60_000).toISOString();
}

describe('parseCsvPoints', () => {
  it('parses rows and sorts them chronologically', () => {
    const points = parseCsvPoints(
      csv([{ timestamp: '2026-01-01T10:05:00Z' }, { timestamp: '2026-01-01T10:00:00Z' }])
    );
    expect(points.map(p => p.timestamp)).toEqual(['2026-01-01T10:00:00Z', '2026-01-01T10:05:00Z']);
    expect(points[0]).toMatchObject({ trip_id: 't1', lat: 12.97, lon: 77.59, speed_mps: 5, speed_kmh: 18 });
  });

  it('treats speed=-1 as unknown rather than stationary', () => {
    const [p] = parseCsvPoints(csv([{ timestamp: '2026-01-01T10:00:00Z', speed_mps: -1 }]));
    expect(p.speed_mps).toBeUndefined();
    expect(p.speed_kmh).toBeUndefined();
  });

  it('drops rows with bad timestamps or coordinates', () => {
    const points = parseCsvPoints(
      csv([
        { timestamp: 'not-a-date' },
        { timestamp: '2026-13-45T99:00:00Z' },
        { timestamp: '2026-01-01T10:00:00Z', lat: 'abc' },
        { timestamp: '2026-01-01T10:00:00Z', lat: 95 },
        { timestamp: '2026-01-01T10:00:00Z', lon: -181 },
        { timestamp: '2026-01-01T10:01:00Z' },
      ])
    );
    expect(points).toHaveLength(1);
    expect(points[0].timestamp).toBe('2026-01-01T10:01:00Z');
  });

  it('drops points less accurate than maxAccuracy', () => {
    const rows = [
      { timestamp: '2026-01-01T10:00:00Z', accuracy_m: 20 },
      { timestamp: '2026-01-01T10:01:00Z', accuracy_m: 80 },
    ];
    expect(parseCsvPoints(csv(rows))).toHaveLength(1);
    expect(parseCsvPoints(csv(rows), 100)).toHaveLength(2);
  });

  it('normalises trip mode and fills defaults', () => {
    const [p] = parseCsvPoints(
      'timestamp,lat,lon,trip_mode\n2026-01-01T10:00:00Z,12.9,77.5, Walking '
    );
    expect(p.trip_mode).toBe('walking');
    expect(p.trip_id).toBe('default_trip');
    expect(p.trip_distance_m).toBe(0);
  });
});

describe('extractStops', () => {
  const start = '2026-01-01T10:00:00Z';

  it('needs 3+ consecutive stationary points', () => {
    const points = parseCsvPoints(
      csv([
        { timestamp: at(start, 0), motion: 'stationary' },
        { timestamp: at(start, 1), motion: 'stationary' },
        { timestamp: at(start, 2), motion: 'driving' },
        { timestamp: at(start, 3), motion: 'stationary', lat: 13 },
        { timestamp: at(start, 4), motion: 'stationary', lat: 13.002 },
        { timestamp: at(start, 6), motion: 'stationary', lat: 13.004 },
      ])
    );
    const stops = extractStops(points);
    expect(stops).toHaveLength(1);
    expect(stops[0].properties).toMatchObject({
      point_count: 3,
      duration_s: 180,
      duration_formatted: '3m',
      lat: 13.002,
      start_time: at(start, 3),
      end_time: at(start, 6),
    });
    expect(stops[0].geometry.coordinates).toEqual([77.59, 13.002]);
  });

  it('counts speed 0 as stationary but not unknown speed (-1)', () => {
    const zero = parseCsvPoints(
      csv([0, 1, 2].map(m => ({ timestamp: at(start, m), motion: '', speed_mps: 0 })))
    );
    expect(extractStops(zero)).toHaveLength(1);

    const unknown = parseCsvPoints(
      csv([0, 1, 2].map(m => ({ timestamp: at(start, m), motion: '', speed_mps: -1 })))
    );
    expect(extractStops(unknown)).toHaveLength(0);
  });

  it('splits a stop on gaps over 15 minutes', () => {
    const points = parseCsvPoints(
      csv([0, 1, 2, 20, 21, 22].map(m => ({ timestamp: at(start, m), motion: 'stationary' })))
    );
    expect(extractStops(points)).toHaveLength(2);
  });
});

describe('buildTripFeatures', () => {
  const start = '2026-01-01T10:00:00Z';

  it('splits a trip into segments on gaps over 5 minutes', () => {
    const points = parseCsvPoints(
      csv([0, 1, 2, 8, 9, 13].map(m => ({ timestamp: at(start, m) })))
    );
    const [trip] = buildTripFeatures(points);
    expect(trip.segments.map(s => s.points.length)).toEqual([3, 3]);
    expect(trip.properties.segments_count).toBe(2);
    expect(trip.properties.duration_s).toBe(13 * 60);
  });

  it('does not split on a gap of exactly 5 minutes', () => {
    const points = parseCsvPoints(csv([0, 5].map(m => ({ timestamp: at(start, m) }))));
    expect(buildTripFeatures(points)[0].segments).toHaveLength(1);
  });

  it('excludes unknown speeds from averages and max', () => {
    const points = parseCsvPoints(
      csv([
        { timestamp: at(start, 0), speed_mps: 10 },
        { timestamp: at(start, 1), speed_mps: -1 },
        { timestamp: at(start, 2), speed_mps: 20 },
      ])
    );
    const [trip] = buildTripFeatures(points);
    expect(trip.properties.avg_speed_mps).toBe(15);
    expect(trip.properties.max_speed_mps).toBe(20);
    expect(trip.segments[0].points[1].speed_mps).toBeUndefined();
  });

  it('uses the cumulative trip_distance_m range, else haversine', () => {
    const withDistance = parseCsvPoints(
      csv([
        { timestamp: at(start, 0), trip_distance_m: 1000 },
        { timestamp: at(start, 1), trip_distance_m: 1500 },
        { timestamp: at(start, 2), trip_distance_m: 2200 },
      ])
    );
    expect(buildTripFeatures(withDistance)[0].properties.distance_m).toBe(1200);

    // 0.01 degrees of latitude is ~1112 m
    const noDistance = parseCsvPoints(
      csv([
        { timestamp: at(start, 0), lat: 12.0 },
        { timestamp: at(start, 1), lat: 12.01 },
      ])
    );
    expect(buildTripFeatures(noDistance)[0].properties.distance_m).toBeCloseTo(1112, -1);
  });

  it('groups by trip id, picks the majority mode and sorts by start', () => {
    const points = parseCsvPoints(
      csv([
        { timestamp: at(start, 30), trip_id: 'b', trip_mode: 'walking' },
        { timestamp: at(start, 0), trip_id: 'a', trip_mode: 'walking' },
        { timestamp: at(start, 1), trip_id: 'a', trip_mode: 'driving' },
        { timestamp: at(start, 2), trip_id: 'a', trip_mode: 'driving' },
      ])
    );
    const trips = buildTripFeatures(points);
    expect(trips.map(t => t.id)).toEqual(['a', 'b']);
    expect(trips[0].properties.trip_mode).toBe('driving');
  });
});

describe('getAvailableDays', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'somaari-trip-test-'));
    resetParseCache();
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    resetParseCache();
  });

  const write = (name: string, rows: Row[]) => fs.writeFileSync(path.join(dataDir, name), csv(rows));

  it('returns nothing for an empty directory', () => {
    expect(getAvailableDays(dataDir)).toEqual([]);
  });

  it('groups points by their own IST day, not the file they are in', () => {
    // 19:00Z on Jan 1 is 00:30 IST on Jan 2
    write('trips_2026-01-01.csv', [
      { timestamp: '2026-01-01T10:00:00Z', trip_id: 'a' },
      { timestamp: '2026-01-01T10:10:00Z', trip_id: 'a' },
      { timestamp: '2026-01-01T19:00:00Z', trip_id: 'b' },
      { timestamp: '2026-01-01T19:01:00Z', trip_id: 'b' },
    ]);
    const days = getAvailableDays(dataDir);
    expect(days.map(d => d.date)).toEqual(['2026-01-02', '2026-01-01']);
    expect(days.map(d => d.trip_count)).toEqual([1, 1]);
  });

  it('splits a trip crossing IST midnight between both days', () => {
    // 18:20Z-18:40Z is 23:50-00:10 IST
    write('trips_2026-01-01.csv', [
      { timestamp: '2026-01-01T18:20:00Z', trip_distance_m: 0 },
      { timestamp: '2026-01-01T18:29:00Z', trip_distance_m: 900 },
      { timestamp: '2026-01-01T18:31:00Z', trip_distance_m: 1100 },
      { timestamp: '2026-01-01T18:40:00Z', trip_distance_m: 2000 },
    ]);
    const days = getAvailableDays(dataDir);
    const byDate = Object.fromEntries(days.map(d => [d.date, d]));
    expect(byDate['2026-01-01']).toMatchObject({ point_count: 2, total_distance_m: 900, duration_s: 540 });
    expect(byDate['2026-01-02']).toMatchObject({ point_count: 2, total_distance_m: 900, duration_s: 540 });
  });

  it('reads only the files named in the requested IST range', () => {
    // Files are IST-dated: 19:00Z on Jan 1 (00:30 IST Jan 2) belongs in the Jan 2 file
    write('trips_2026-01-01.csv', [{ timestamp: '2026-01-01T10:00:00Z' }, { timestamp: '2026-01-01T19:00:00Z' }]);
    write('trips_2026-01-02.csv', [{ timestamp: '2026-01-02T05:00:00Z' }]);
    write('trips_2026-01-03.csv', [{ timestamp: '2026-01-03T05:00:00Z' }]);
    const times = (from: string, to: string) =>
      loadPointsForIstRange(dataDir, from, to).map(p => new Date(p.timeMs).toISOString());
    expect(times('2026-01-02', '2026-01-02')).toEqual(['2026-01-02T05:00:00.000Z']);
    expect(times('2026-01-01', '2026-01-02')).toEqual(['2026-01-01T10:00:00.000Z', '2026-01-01T19:00:00.000Z', '2026-01-02T05:00:00.000Z']);
  });

  it('ignores files whose names are not trips_YYYY-MM-DD.csv', () => {
    const rows = [{ timestamp: '2026-01-05T10:00:00Z' }];
    write('trips_2026-01-05.csv', rows);
    write('trips_2026-1-6.csv', [{ timestamp: '2026-01-06T10:00:00Z' }]);
    write('trips_latest.csv', [{ timestamp: '2026-01-07T10:00:00Z' }]);
    write('notes.txt', [{ timestamp: '2026-01-08T10:00:00Z' }]);
    expect(getAvailableDays(dataDir).map(d => d.date)).toEqual(['2026-01-05']);
  });

  it('applies the accuracy cutoff', () => {
    write('trips_2026-01-05.csv', [
      { timestamp: '2026-01-05T10:00:00Z', accuracy_m: 10 },
      { timestamp: '2026-01-05T10:01:00Z', accuracy_m: 80 },
    ]);
    expect(getAvailableDays(dataDir)[0].point_count).toBe(1);
    expect(getAvailableDays(dataDir, 100)[0].point_count).toBe(2);
  });

  it('summarises a day split across files from all of its points', () => {
    write('trips_2026-01-01.csv', [{ timestamp: '2026-01-01T10:00:00Z' }, { timestamp: '2026-01-01T19:00:00Z' }]);
    write('trips_2026-01-02.csv', [{ timestamp: '2026-01-02T05:00:00Z' }, { timestamp: '2026-01-02T05:01:00Z' }]);
    const byDate = Object.fromEntries(getAvailableDays(dataDir).map(d => [d.date, d]));
    expect(byDate['2026-01-01'].point_count).toBe(1);
    expect(byDate['2026-01-02']).toMatchObject({ point_count: 3, trip_count: 1 });
  });

  it('picks up changes to a file and drops deleted files', () => {
    write('trips_2026-01-05.csv', [{ timestamp: '2026-01-05T10:00:00Z' }]);
    write('trips_2026-01-06.csv', [{ timestamp: '2026-01-06T10:00:00Z' }]);
    expect(getAvailableDays(dataDir).map(d => d.point_count)).toEqual([1, 1]);
    write('trips_2026-01-06.csv', [{ timestamp: '2026-01-06T10:00:00Z' }, { timestamp: '2026-01-06T10:01:00Z' }]);
    expect(getAvailableDays(dataDir).map(d => d.point_count)).toEqual([2, 1]);
    fs.rmSync(path.join(dataDir, 'trips_2026-01-05.csv'));
    expect(getAvailableDays(dataDir).map(d => d.date)).toEqual(['2026-01-06']);
  });

  it('does not fill the parse cache when summarising', () => {
    write('trips_2026-01-05.csv', [{ timestamp: '2026-01-05T10:00:00Z' }]);
    getAvailableDays(dataDir);
    expect(parseCachePointCount()).toBe(0);
    loadPointsForIstRange(dataDir, '2026-01-05', '2026-01-05');
    expect(parseCachePointCount()).toBe(1);
  });

  it('caps the parse cache by total points, evicting the least recently used file', () => {
    resetParseCache(4);
    const two = (day: string, m: number) => [{ timestamp: `${day}T05:0${m}:00Z` }, { timestamp: `${day}T05:0${m + 1}:00Z` }];
    const days = ['2026-01-01', '2026-01-02', '2026-01-03'];
    // Whole-second mtime, so it can be restored exactly after a rewrite
    const pinMtime = (d: string) => fs.utimesSync(path.join(dataDir, `trips_${d}.csv`), 1e9, 1e9);
    for (const d of days) {
      write(`trips_${d}.csv`, two(d, 0));
      pinMtime(d);
    }
    write('trips_2026-01-04.csv', [1, 2, 3, 4, 5].map(m => ({ timestamp: `2026-01-04T05:0${m}:00Z` })));
    const first = (d: string) => loadPointsForIstRange(dataDir, d, d)[0]?.timestamp;
    first('2026-01-01');
    first('2026-01-02');
    first('2026-01-01'); // now most recently used
    first('2026-01-03'); // evicts Jan 2
    expect(parseCachePointCount()).toBe(4);

    // Same size and mtime, so only an evicted file is read again
    for (const d of days) {
      write(`trips_${d}.csv`, two(d, 2));
      pinMtime(d);
    }
    expect(first('2026-01-01')).toBe('2026-01-01T05:00:00Z');
    expect(first('2026-01-03')).toBe('2026-01-03T05:00:00Z');
    expect(first('2026-01-02')).toBe('2026-01-02T05:02:00Z');

    // Too big to cache at all, but still returned
    expect(loadPointsForIstRange(dataDir, '2026-01-04', '2026-01-04')).toHaveLength(5);
    expect(parseCachePointCount()).toBe(4);
  });
});
