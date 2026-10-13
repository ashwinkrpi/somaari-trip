import fs from 'fs/promises';
import path from 'path';
import { istDate } from './tripParser.ts';

/** Column order of the daily CSVs (matches README and the files n8n wrote) */
export const CSV_HEADER =
  'timestamp,trip_id,lat,lon,speed_mps,speed_accuracy,course,course_accuracy,altitude_m,vertical_accuracy,accuracy_m,battery_level,battery_state,motion,wifi_ssid,device_id,trip_distance_m,trip_mode,trip_start';

export interface DailyRows {
  date: string; // IST YYYY-MM-DD
  rows: string[]; // CSV lines without trailing newline
}

/** Same escaping as the n8n workflow: no quoting, commas become `;`, newlines become spaces */
function esc(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/,/g, ';').replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Converts an Overland batch (`{ locations: Feature[], trip? }`) into CSV rows grouped by
 * the IST date of each point. Points with a missing or invalid timestamp are dropped.
 */
export function overlandToDailyRows(body: any): DailyRows[] {
  const trip = body?.trip ?? {};
  const locations: any[] = Array.isArray(body?.locations) ? body.locations : [];
  const byDate = new Map<string, string[]>();

  for (const loc of locations) {
    const p = loc?.properties ?? {};
    const timeMs = new Date(p.timestamp).getTime();
    if (!p.timestamp || isNaN(timeMs)) continue;

    const [lon, lat] = Array.isArray(loc?.geometry?.coordinates) ? loc.geometry.coordinates : [];
    const motion = Array.isArray(p.motion) ? p.motion.join(';') : p.motion;
    const wifi = typeof p.wifi === 'string' ? p.wifi : p.wifi?.ssid || null;

    const row = [
      p.timestamp,
      p.trip_id,
      lat,
      lon,
      p.speed,
      p.speed_accuracy,
      p.course,
      p.course_accuracy,
      p.altitude,
      p.vertical_accuracy,
      p.horizontal_accuracy,
      p.battery_level,
      p.battery_state,
      motion,
      wifi,
      p.device_id,
      trip.distance,
      trip.mode,
      trip.start,
    ].map(esc).join(',');

    const date = istDate(timeMs);
    const rows = byDate.get(date);
    if (rows) rows.push(row);
    else byDate.set(date, [row]);
  }

  return [...byDate].map(([date, rows]) => ({ date, rows }));
}

/** Tail of the pending appends per file, so concurrent batches never interleave */
const fileQueues = new Map<string, Promise<void>>();

function enqueue(file: string, task: () => Promise<void>): Promise<void> {
  const next = (fileQueues.get(file) ?? Promise.resolve()).then(task, task);
  const tail = next.catch(() => {});
  fileQueues.set(file, tail);
  tail.then(() => {
    if (fileQueues.get(file) === tail) fileQueues.delete(file);
  });
  return next;
}

/** Appends each day's rows to `trips_<date>.csv`, writing the header first if the file is new or empty */
export async function appendDailyRows(dataDir: string, days: DailyRows[]): Promise<void> {
  await Promise.all(
    days.map(({ date, rows }) => {
      const file = path.join(dataDir, `trips_${date}.csv`);
      return enqueue(file, async () => {
        const fh = await fs.open(file, 'a');
        try {
          const { size } = await fh.stat();
          const lines = size === 0 ? [CSV_HEADER, ...rows] : rows;
          await fh.appendFile(lines.join('\n') + '\n');
        } finally {
          await fh.close();
        }
      });
    }),
  );
}
