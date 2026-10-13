import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendDailyRows, CSV_HEADER, overlandToDailyRows } from './overlandIngest.ts';
import { parseCsvPoints } from './tripParser.ts';

function feature(props: Record<string, unknown>, coords: [number, number] = [77.5946123, 12.9716057]) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: coords },
    properties: {
      timestamp: '2026-10-13T09:15:30Z',
      trip_id: '2026-10-13T09:10:00Z',
      speed: 14,
      speed_accuracy: 1.53,
      course: 44,
      course_accuracy: 9.03,
      altitude: 900,
      vertical_accuracy: 3,
      horizontal_accuracy: 10,
      battery_level: 0.7,
      battery_state: 'unplugged',
      motion: ['driving', 'stationary'],
      wifi: '',
      device_id: '',
      ...props,
    },
  };
}

const TRIP = { distance: 2104.567891234568, mode: 'metro', start: '2026-10-13T09:10:00Z' };

describe('overlandToDailyRows', () => {
  it('produces the same line format n8n wrote', () => {
    const out = overlandToDailyRows({ locations: [feature({})], trip: TRIP });
    expect(out).toEqual([
      {
        date: '2026-10-13',
        rows: [
          '2026-10-13T09:15:30Z,2026-10-13T09:10:00Z,12.9716057,77.5946123,14,1.53,44,9.03,900,3,10,0.7,unplugged,driving;stationary,,,2104.567891234568,metro,2026-10-13T09:10:00Z',
        ],
      },
    ]);
  });

  it('escapes commas and newlines in the SSID and accepts wifi objects', () => {
    const out = overlandToDailyRows({
      locations: [feature({ wifi: ' Cafe, Home\r\n\nNet ' }), feature({ wifi: { ssid: 'a,b' } })],
    });
    const cols = out[0].rows.map(r => r.split(','));
    expect(cols[0]).toHaveLength(19);
    expect(cols[0][14]).toBe('Cafe; Home Net');
    expect(cols[1][14]).toBe('a;b');
  });

  it('joins motion arrays and leaves empty motion blank', () => {
    const out = overlandToDailyRows({ locations: [feature({ motion: ['walking'] }), feature({ motion: [] })] });
    expect(out[0].rows.map(r => r.split(',')[13])).toEqual(['walking', '']);
  });

  it('leaves trip columns empty when the batch has no trip', () => {
    const [{ rows }] = overlandToDailyRows({ locations: [feature({})] });
    expect(rows[0].endsWith(',,,')).toBe(true);
  });

  it('writes empty strings for null/undefined properties', () => {
    const [{ rows }] = overlandToDailyRows({
      locations: [feature({ speed: null, battery_state: undefined, trip_id: undefined })],
    });
    const cols = rows[0].split(',');
    expect([cols[1], cols[4], cols[12]]).toEqual(['', '', '']);
  });

  it('drops points with missing or invalid timestamps', () => {
    const out = overlandToDailyRows({
      locations: [feature({ timestamp: 'nope' }), feature({ timestamp: undefined }), feature({})],
    });
    expect(out).toHaveLength(1);
    expect(out[0].rows).toHaveLength(1);
  });

  it('splits a batch at IST midnight', () => {
    const out = overlandToDailyRows({
      locations: [
        feature({ timestamp: '2026-10-13T18:29:59Z' }),
        feature({ timestamp: '2026-10-13T18:30:00Z' }),
        feature({ timestamp: '2026-10-13T18:29:00Z' }),
      ],
    });
    expect(out.map(d => [d.date, d.rows.length])).toEqual([
      ['2026-10-13', 2],
      ['2026-10-14', 1],
    ]);
  });

  it('returns nothing for a batch without locations', () => {
    expect(overlandToDailyRows({})).toEqual([]);
    expect(overlandToDailyRows(null)).toEqual([]);
  });

  it('round-trips through parseCsvPoints', () => {
    const [{ rows }] = overlandToDailyRows({
      locations: [feature({ wifi: 'x,y' }), feature({ timestamp: '2026-10-13T09:16:30Z', speed: -1 })],
      trip: TRIP,
    });
    const points = parseCsvPoints([CSV_HEADER, ...rows].join('\n'));
    expect(points).toHaveLength(2);
    expect(points[0]).toMatchObject({
      timestamp: '2026-10-13T09:15:30Z',
      trip_id: '2026-10-13T09:10:00Z',
      lat: 12.9716057,
      lon: 77.5946123,
      speed_mps: 14,
      accuracy_m: 10,
      motion: 'driving;stationary',
      wifi_ssid: 'x;y',
      trip_distance_m: 2104.567891234568,
      trip_mode: 'metro',
      trip_start: '2026-10-13T09:10:00Z',
    });
    expect(points[1].speed_mps).toBeUndefined();
  });
});

describe('appendDailyRows', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overland-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const read = (date: string) => fs.readFileSync(path.join(dir, `trips_${date}.csv`), 'utf8');

  it('writes the header only when the file is new', async () => {
    await appendDailyRows(dir, [{ date: '2026-10-13', rows: ['a', 'b'] }]);
    await appendDailyRows(dir, [{ date: '2026-10-13', rows: ['c'] }]);
    expect(read('2026-10-13')).toBe(`${CSV_HEADER}\na\nb\nc\n`);
  });

  it('appends to an existing file without adding a header', async () => {
    fs.writeFileSync(path.join(dir, 'trips_2026-10-12.csv'), `${CSV_HEADER}\nold\n\n`);
    await appendDailyRows(dir, [{ date: '2026-10-12', rows: ['new'] }]);
    expect(read('2026-10-12')).toBe(`${CSV_HEADER}\nold\n\nnew\n`);
  });

  it('keeps concurrent batches whole and writes one header', async () => {
    const batches = Array.from({ length: 20 }, (_, i) => [`${i}-1`, `${i}-2`, `${i}-3`]);
    await Promise.all(batches.map((rows) => appendDailyRows(dir, [{ date: '2026-10-13', rows }])));
    const lines = read('2026-10-13').trimEnd().split('\n');
    expect(lines[0]).toBe(CSV_HEADER);
    expect(lines.filter((l) => l === CSV_HEADER)).toHaveLength(1);
    const body = lines.slice(1);
    expect(body).toHaveLength(60);
    for (let i = 0; i < body.length; i += 3) {
      const id = body[i].split('-')[0];
      expect(body.slice(i, i + 3)).toEqual([`${id}-1`, `${id}-2`, `${id}-3`]);
    }
  });

  it('splits a batch across IST days into separate files', async () => {
    const body = {
      locations: [
        feature({ timestamp: '2026-10-13T18:29:59Z' }),
        feature({ timestamp: '2026-10-13T18:30:00Z' }),
      ],
    };
    await appendDailyRows(dir, overlandToDailyRows(body));
    expect(read('2026-10-13').split('\n')).toHaveLength(3);
    expect(read('2026-10-14').split('\n')).toHaveLength(3);
  });
});
