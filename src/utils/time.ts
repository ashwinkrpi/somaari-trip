/**
 * Time and unit conversion helpers with strict IST (Asia/Kolkata, UTC+5:30) conversion
 */

export function formatToIST(isoString: string | undefined | null, options: { includeDate?: boolean; short?: boolean } = {}): string {
  if (!isoString) return '--';
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return '--';

    const { includeDate = true, short = false } = options;

    const formatter = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      year: includeDate ? (short ? '2-digit' : 'numeric') : undefined,
      month: includeDate ? (short ? 'short' : 'short') : undefined,
      day: includeDate ? 'numeric' : undefined,
      hour: '2-digit',
      minute: '2-digit',
      second: short ? undefined : '2-digit',
      hour12: true,
    });

    return formatter.format(date) + ' IST';
  } catch (err) {
    return isoString;
  }
}

export function formatTimeOnlyIST(isoString: string | undefined | null): string {
  if (!isoString) return '--';
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return '--';

    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(date);
  } catch {
    return isoString;
  }
}

export { formatDuration } from '../../shared/format.ts';

export function formatDistance(meters: number): string {
  if (!meters || meters < 0) return '0 m';
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

export const MODE_COLORS: Record<string, { bg: string; border: string; hex: string; label: string }> = {
  walking: { bg: 'bg-emerald-500/15', border: 'border-emerald-500/40', hex: '#10B981', label: 'Walking' },
  running: { bg: 'bg-teal-500/15', border: 'border-teal-500/40', hex: '#14B8A6', label: 'Running' },
  cycling: { bg: 'bg-cyan-500/15', border: 'border-cyan-500/40', hex: '#06B6D4', label: 'Cycling' },
  driving: { bg: 'bg-amber-500/15', border: 'border-amber-500/40', hex: '#F59E0B', label: 'Driving' },
  automotive: { bg: 'bg-amber-500/15', border: 'border-amber-500/40', hex: '#F59E0B', label: 'Driving' },
  motorcycle: { bg: 'bg-orange-500/15', border: 'border-orange-500/40', hex: '#F97316', label: 'Motorcycle' },
  train: { bg: 'bg-indigo-500/15', border: 'border-indigo-500/40', hex: '#6366F1', label: 'Train / Rail' },
  stationary: { bg: 'bg-neutral-500/15', border: 'border-neutral-500/40', hex: '#737373', label: 'Stationary' },
  unknown: { bg: 'bg-neutral-600/15', border: 'border-neutral-500/40', hex: '#9CA3AF', label: 'Other' },
};

export function getModeColor(mode: string): string {
  const clean = (mode || 'unknown').toLowerCase().trim();
  return MODE_COLORS[clean]?.hex || MODE_COLORS.unknown.hex;
}

/**
 * Returns hex color from green -> yellow -> red based on speed in m/s
 * 0-3 m/s (~10 km/h): green
 * 3-10 m/s (~36 km/h): lime/yellow
 * 10-20 m/s (~72 km/h): orange
 * 20+ m/s (~72+ km/h): red
 */
export function getSpeedColor(speed_mps: number | undefined): string {
  if (speed_mps === undefined) return '#737373'; // grey: speed unknown
  const kmh = speed_mps * 3.6;
  if (kmh <= 5) return '#10B981'; // green
  if (kmh <= 20) return '#84CC16'; // lime
  if (kmh <= 45) return '#EAB308'; // yellow
  if (kmh <= 75) return '#F97316'; // orange
  return '#EF4444'; // red
}
