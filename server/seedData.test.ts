import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateSampleDays } from './seedData.ts';
import { buildTripFeatures, extractStops, haversineMeters, parseCsvPoints } from './tripParser.ts';

describe('generateSampleDays', () => {
  let dir: string;
  let files: string[];

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'somaari-trip-seed-'));
    generateSampleDays(dir);
    files = fs.readdirSync(dir).sort();
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes six days of three trips each, with stops', () => {
    expect(files).toHaveLength(6);
    for (const f of files) {
      const points = parseCsvPoints(fs.readFileSync(path.join(dir, f), 'utf-8'));
      const tripIds = new Set(buildTripFeatures(points).map(t => t.properties.trip_id));
      expect(tripIds.size).toBe(3);
      expect(extractStops(points).length).toBeGreaterThanOrEqual(2);
    }
  });

  it('logs points close together, so tracks follow the road instead of cutting corners', () => {
    for (const f of files) {
      const points = parseCsvPoints(fs.readFileSync(path.join(dir, f), 'utf-8'));
      for (let i = 1; i < points.length; i++) {
        const [a, b] = [points[i - 1], points[i]];
        if (a.trip_id !== b.trip_id) continue;
        expect(haversineMeters(a.lat, a.lon, b.lat, b.lon)).toBeLessThan(60);
      }
    }
  });

  it('is the same every run', () => {
    const again = fs.mkdtempSync(path.join(os.tmpdir(), 'somaari-trip-seed-'));
    try {
      generateSampleDays(again);
      for (const f of files) {
        expect(fs.readFileSync(path.join(again, f), 'utf-8')).toBe(fs.readFileSync(path.join(dir, f), 'utf-8'));
      }
    } finally {
      fs.rmSync(again, { recursive: true, force: true });
    }
  });
});
