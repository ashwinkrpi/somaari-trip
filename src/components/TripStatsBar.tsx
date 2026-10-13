import React from 'react';
import { TripsResponse } from '../../shared/types.ts';
import { formatDistance, formatDuration } from '../utils/time.ts';
import { Route, Clock, Gauge, Compass, MapPin, Zap } from 'lucide-react';

interface TripStatsBarProps {
  summary: TripsResponse['summary'];
  dateLabel: string;
  selectedTripMode?: string | null;
}

export const TripStatsBar: React.FC<TripStatsBarProps> = ({ summary, dateLabel, selectedTripMode }) => {
  return (
    <div
      id="trip-stats-bar"
      className="bg-neutral-900/90 border-b border-neutral-800/80 pl-14 pr-4 md:px-4 py-2.5 backdrop-blur-md flex items-center justify-between gap-4 flex-wrap z-10"
    >
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-xs font-semibold text-neutral-200 tracking-wide">{dateLabel}</span>
        </div>
        {selectedTripMode && (
          <span className="text-[11px] px-2 py-0.5 rounded bg-neutral-800 text-indigo-400 border border-neutral-700 font-medium capitalize">
            {selectedTripMode}
          </span>
        )}
      </div>

      <div className="flex items-center gap-4 md:gap-6 text-xs text-neutral-300 flex-wrap">
        <div className="flex items-center gap-1.5" title="Total Distance">
          <Route className="w-3.5 h-3.5 text-indigo-400" />
          <span className="text-neutral-400">Dist:</span>
          <span className="font-semibold text-neutral-100">{formatDistance(summary.total_distance_m)}</span>
        </div>

        <div className="flex items-center gap-1.5" title="Total Duration">
          <Clock className="w-3.5 h-3.5 text-amber-400" />
          <span className="text-neutral-400">Time:</span>
          <span className="font-semibold text-neutral-100">{formatDuration(summary.total_duration_s)}</span>
        </div>

        <div className="flex items-center gap-1.5" title="Average Speed">
          <Gauge className="w-3.5 h-3.5 text-emerald-400" />
          <span className="text-neutral-400">Avg:</span>
          <span className="font-semibold text-neutral-100">{summary.avg_speed_kmh} km/h</span>
        </div>

        <div className="flex items-center gap-1.5" title="Max Speed">
          <Zap className="w-3.5 h-3.5 text-rose-400" />
          <span className="text-neutral-400">Max:</span>
          <span className="font-semibold text-neutral-100">{summary.max_speed_kmh} km/h</span>
        </div>

        <div className="flex items-center gap-1.5" title="Trip Count">
          <Compass className="w-3.5 h-3.5 text-blue-400" />
          <span className="text-neutral-400">Trips:</span>
          <span className="font-semibold text-neutral-100">{summary.total_trips}</span>
        </div>

        <div className="flex items-center gap-1.5" title="Stationary Stops">
          <MapPin className="w-3.5 h-3.5 text-purple-400" />
          <span className="text-neutral-400">Stops:</span>
          <span className="font-semibold text-neutral-100">{summary.total_stops}</span>
        </div>
      </div>
    </div>
  );
};
