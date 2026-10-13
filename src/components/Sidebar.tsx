import React, { useState } from 'react';
import { DaySummary, TripFeature } from '../../shared/types.ts';
import {
  formatDuration,
  formatDistance,
  formatTimeOnlyIST,
  MODE_COLORS,
  getModeColor,
} from '../utils/time.ts';
import {
  Calendar,
  Sliders,
  RefreshCw,
  Compass,
  CalendarRange,
  X,
} from 'lucide-react';

interface SidebarProps {
  days: DaySummary[];
  selectedDate: string;
  selectedRange: { from: string; to: string } | null;
  selectionMode: 'single' | 'range';
  onSelectDate: (date: string) => void;
  onSelectRange: (range: { from: string; to: string } | null) => void;
  onSetSelectionMode: (mode: 'single' | 'range') => void;
  colorMode: 'mode' | 'speed';
  onChangeColorMode: (mode: 'mode' | 'speed') => void;
  accuracyThreshold: number;
  onChangeAccuracy: (accuracy: number) => void;
  showStops: boolean;
  onToggleStops: () => void;
  trips: TripFeature[];
  availableModes: string[];
  selectedTripId: string | null;
  onSelectTrip: (tripId: string | null) => void;
  filteredModes: string[];
  onToggleModeFilter: (mode: string) => void;
  isLoading: boolean;
  onRefreshDays: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  days,
  selectedDate,
  selectedRange,
  selectionMode,
  onSelectDate,
  onSelectRange,
  onSetSelectionMode,
  colorMode,
  onChangeColorMode,
  accuracyThreshold,
  onChangeAccuracy,
  showStops,
  onToggleStops,
  trips,
  availableModes,
  selectedTripId,
  onSelectTrip,
  filteredModes,
  onToggleModeFilter,
  isLoading,
  onRefreshDays,
}) => {
  const [activeTab, setActiveTab] = useState<'calendar' | 'trips' | 'settings'>('calendar');
  // First click of a range; the next click completes it, a click after that starts over
  const [rangeAnchor, setRangeAnchor] = useState<string | null>(null);

  const selectPresetRange = (range: { from: string; to: string } | null) => {
    setRangeAnchor(null);
    onSelectRange(range);
  };

  const handleRangeClick = (date: string) => {
    if (rangeAnchor === null) {
      setRangeAnchor(date);
      onSelectRange({ from: date, to: date });
    } else {
      setRangeAnchor(null);
      onSelectRange(date < rangeAnchor ? { from: date, to: rangeAnchor } : { from: rangeAnchor, to: date });
    }
  };

  // Calculate max distance among days for heatmap intensity scaling
  const maxDist = Math.max(1, ...days.map(d => d.total_distance_m));

  const getHeatmapColorClass = (distMeters: number) => {
    const ratio = distMeters / maxDist;
    if (ratio === 0) return 'bg-neutral-800 text-neutral-400';
    if (ratio < 0.25) return 'bg-emerald-950/60 border-emerald-800/60 text-emerald-300';
    if (ratio < 0.5) return 'bg-emerald-900/70 border-emerald-700/60 text-emerald-200';
    if (ratio < 0.75) return 'bg-emerald-700/80 border-emerald-600/70 text-emerald-100';
    return 'bg-emerald-600 border-emerald-500 text-white shadow-sm';
  };

  return (
    <aside
      id="somaari-trip-sidebar"
      className="w-80 md:w-96 h-full bg-neutral-950/95 border-r border-neutral-800/90 flex flex-col shrink-0 z-20 select-none overflow-hidden"
    >
      {/* Header */}
      <div className="px-4 py-3.5 border-b border-neutral-800/80 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-emerald-500 flex items-center justify-center shadow-md">
            <Compass className="w-4 h-4 text-white" />
          </div>
          <div>
            <h1 className="text-sm font-bold text-neutral-100 tracking-tight flex items-center gap-1.5">
              Somaari Trip
              <span className="text-[10px] px-1.5 py-0.2 rounded font-normal bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                Self-Hosted
              </span>
            </h1>
            <p className="text-[11px] text-neutral-400">Overland GPS Logs (IST)</p>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            id="btn-refresh-days"
            type="button"
            onClick={onRefreshDays}
            title="Refresh logs"
            className="p-1.5 text-neutral-400 hover:text-white rounded-md hover:bg-neutral-800 transition"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="px-3 pt-2 pb-1 flex border-b border-neutral-800/60 gap-1 bg-neutral-900/40">
        <button
          type="button"
          onClick={() => setActiveTab('calendar')}
          className={`flex-1 py-1.5 text-xs font-medium rounded-md flex items-center justify-center gap-1.5 transition ${
            activeTab === 'calendar'
              ? 'bg-neutral-800 text-indigo-300 shadow-sm'
              : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'
          }`}
        >
          <Calendar className="w-3.5 h-3.5" />
          <span>Dates ({days.length})</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('trips')}
          className={`flex-1 py-1.5 text-xs font-medium rounded-md flex items-center justify-center gap-1.5 transition ${
            activeTab === 'trips'
              ? 'bg-neutral-800 text-indigo-300 shadow-sm'
              : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'
          }`}
        >
          <Compass className="w-3.5 h-3.5" />
          <span>Trips ({trips.length})</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('settings')}
          className={`flex-1 py-1.5 text-xs font-medium rounded-md flex items-center justify-center gap-1.5 transition ${
            activeTab === 'settings'
              ? 'bg-neutral-800 text-indigo-300 shadow-sm'
              : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'
          }`}
        >
          <Sliders className="w-3.5 h-3.5" />
          <span>Display</span>
        </button>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {/* CALENDAR & DATES TAB */}
        {activeTab === 'calendar' && (
          <div className="space-y-3">
            {/* Selection Mode Toggle: Single Day vs Date Range */}
            <div className="flex items-center justify-between p-1 bg-neutral-900 border border-neutral-800 rounded-lg">
              <button
                type="button"
                onClick={() => {
                  setRangeAnchor(null);
                  onSetSelectionMode('single');
                }}
                className={`flex-1 py-1 text-xs font-medium rounded-md flex items-center justify-center gap-1.5 transition ${
                  selectionMode === 'single'
                    ? 'bg-indigo-600/30 text-indigo-300 border border-indigo-500/40'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                <Calendar className="w-3 h-3" />
                <span>Single Day</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setRangeAnchor(null);
                  onSetSelectionMode('range');
                }}
                className={`flex-1 py-1 text-xs font-medium rounded-md flex items-center justify-center gap-1.5 transition ${
                  selectionMode === 'range'
                    ? 'bg-indigo-600/30 text-indigo-300 border border-indigo-500/40'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                <CalendarRange className="w-3 h-3" />
                <span>Date Range</span>
              </button>
            </div>

            {/* Quick Range Presets (when in range mode) */}
            {selectionMode === 'range' && days.length > 0 && (
              <div className="flex gap-1.5 flex-wrap">
                <button
                  type="button"
                  onClick={() => selectPresetRange({ from: days[days.length - 1].date, to: days[0].date })}
                  className="px-2 py-1 text-[11px] rounded bg-neutral-900 hover:bg-neutral-800 text-neutral-300 border border-neutral-800 transition"
                >
                  All Days ({days.length})
                </button>
                {days.length >= 3 && (
                  <button
                    type="button"
                    onClick={() => selectPresetRange({ from: days[2].date, to: days[0].date })}
                    className="px-2 py-1 text-[11px] rounded bg-neutral-900 hover:bg-neutral-800 text-neutral-300 border border-neutral-800 transition"
                  >
                    Past 3 Days
                  </button>
                )}
                {days.length >= 7 && (
                  <button
                    type="button"
                    onClick={() => selectPresetRange({ from: days[6].date, to: days[0].date })}
                    className="px-2 py-1 text-[11px] rounded bg-neutral-900 hover:bg-neutral-800 text-neutral-300 border border-neutral-800 transition"
                  >
                    Past 7 Days
                  </button>
                )}
                {selectedRange && (
                  <button
                    type="button"
                    onClick={() => selectPresetRange(null)}
                    className="px-2 py-1 text-[11px] rounded bg-neutral-900 hover:bg-neutral-800 text-rose-300 border border-neutral-800 transition flex items-center gap-1"
                  >
                    <X className="w-3 h-3" />
                    Clear
                  </button>
                )}
              </div>
            )}

            {selectionMode === 'range' && days.length > 0 && (
              <p className="text-[10px] text-neutral-500 px-1">
                {rangeAnchor
                  ? `Range starts ${rangeAnchor}. Click another day to set the end.`
                  : 'Click a day to start a range, then another to end it.'}
              </p>
            )}

            {/* List of Available Days with Activity Heatmap indicator */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-neutral-400 font-semibold uppercase tracking-wider px-1">
                <span>Available Trip Logs</span>
                <span>{days.length} days</span>
              </div>

              {days.length === 0 ? (
                <div className="p-4 rounded-lg bg-neutral-900/50 border border-neutral-800 text-center text-xs text-neutral-400">
                  <p>No CSV files found in <code className="text-indigo-400">./data/</code></p>
                </div>
              ) : (
                days.map(d => {
                  const isSingleSelected = selectionMode === 'single' && selectedDate === d.date;
                  const isInRange =
                    selectionMode === 'range' &&
                    selectedRange &&
                    d.date >= selectedRange.from &&
                    d.date <= selectedRange.to;

                  return (
                    <button
                      key={d.date}
                      type="button"
                      onClick={() => {
                        if (selectionMode === 'single') {
                          onSelectDate(d.date);
                        } else {
                          handleRangeClick(d.date);
                        }
                      }}
                      className={`w-full text-left p-2.5 rounded-lg border transition-all flex items-center justify-between gap-2 ${
                        isSingleSelected || isInRange
                          ? 'bg-indigo-950/40 border-indigo-500/60 shadow-sm'
                          : 'bg-neutral-900/70 border-neutral-800/80 hover:bg-neutral-800/60'
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        {/* Heatmap Activity Dot / Pill */}
                        <div
                          className={`w-3 h-3 rounded-full border shrink-0 ${getHeatmapColorClass(d.total_distance_m)}`}
                          title={`Activity Level: ${formatDistance(d.total_distance_m)} (${d.point_count} pts)`}
                        />

                        <div>
                          <div className="text-xs font-semibold text-neutral-200">
                            {d.date}
                          </div>
                          <div className="text-[11px] text-neutral-400 flex items-center gap-1.5 mt-0.5">
                            <span>{d.trip_count} {d.trip_count === 1 ? 'trip' : 'trips'}</span>
                            <span>•</span>
                            <span>{formatDistance(d.total_distance_m)}</span>
                            <span>•</span>
                            <span>{formatDuration(d.duration_s)}</span>
                          </div>
                        </div>
                      </div>

                      {/* Modes Badges */}
                      <div className="flex items-center gap-1">
                        {d.modes.slice(0, 2).map(m => (
                          <span
                            key={m}
                            style={{ borderColor: `${getModeColor(m)}66`, color: getModeColor(m) }}
                            className="text-[9px] uppercase px-1.5 py-0.2 rounded border bg-neutral-950 font-medium"
                          >
                            {m.slice(0, 4)}
                          </span>
                        ))}
                        {d.modes.length > 2 && (
                          <span className="text-[9px] text-neutral-400">+{d.modes.length - 2}</span>
                        )}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* TRIPS LIST TAB */}
        {activeTab === 'trips' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[11px] text-neutral-400 font-semibold uppercase tracking-wider px-1">
              <span>Trips in Current View</span>
              <span>{trips.length}</span>
            </div>

            {trips.length === 0 ? (
              <div className="p-4 rounded-lg bg-neutral-900/50 border border-neutral-800 text-center text-xs text-neutral-400">
                No trips loaded for this selection.
              </div>
            ) : (
              trips.map(trip => {
                const isSelected = selectedTripId === trip.properties.trip_id;
                const modeColor = getModeColor(trip.properties.trip_mode);

                return (
                  <div
                    key={trip.properties.trip_id}
                    onClick={() => onSelectTrip(isSelected ? null : trip.properties.trip_id)}
                    className={`p-3 rounded-lg border cursor-pointer transition-all ${
                      isSelected
                        ? 'bg-neutral-800/90 border-indigo-500 shadow-md ring-1 ring-indigo-500/50'
                        : 'bg-neutral-900/70 border-neutral-800 hover:bg-neutral-800/60'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <span
                        style={{
                          backgroundColor: `${modeColor}22`,
                          color: modeColor,
                          borderColor: `${modeColor}55`,
                        }}
                        className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded border"
                      >
                        {trip.properties.trip_mode}
                      </span>
                      <span className="text-[11px] text-neutral-400 font-mono">
                        {formatTimeOnlyIST(trip.properties.start_time)} - {formatTimeOnlyIST(trip.properties.end_time)}
                      </span>
                    </div>

                    <div className="grid grid-cols-3 gap-2 text-[11px] mt-2 pt-2 border-t border-neutral-800/60 text-neutral-300">
                      <div>
                        <div className="text-[10px] text-neutral-500">Distance</div>
                        <div className="font-semibold text-neutral-100">{formatDistance(trip.properties.distance_m)}</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-neutral-500">Duration</div>
                        <div className="font-semibold text-neutral-100">{formatDuration(trip.properties.duration_s)}</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-neutral-500">Avg Speed</div>
                        <div className="font-semibold text-neutral-100">{trip.properties.avg_speed_kmh} km/h</div>
                      </div>
                    </div>

                    {trip.properties.segments_count > 1 && (
                      <div className="mt-2 text-[10px] text-amber-400/90 bg-amber-950/30 px-2 py-0.5 rounded border border-amber-800/40">
                        ⚡ {trip.properties.segments_count} segments (gaps &gt;5m)
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* SETTINGS / DISPLAY TAB */}
        {activeTab === 'settings' && (
          <div className="space-y-4">
            {/* Color Mode Toggle */}
            <div className="p-3 bg-neutral-900 border border-neutral-800 rounded-lg space-y-2">
              <label className="text-xs font-semibold text-neutral-200 block">
                Polyline Color Mode
              </label>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => onChangeColorMode('mode')}
                  className={`py-1.5 px-2 text-xs font-medium rounded border transition ${
                    colorMode === 'mode'
                      ? 'bg-indigo-600/30 border-indigo-500 text-indigo-200 font-semibold'
                      : 'bg-neutral-950 border-neutral-800 text-neutral-400 hover:text-neutral-200'
                  }`}
                >
                  By Trip Mode
                </button>
                <button
                  type="button"
                  onClick={() => onChangeColorMode('speed')}
                  className={`py-1.5 px-2 text-xs font-medium rounded border transition ${
                    colorMode === 'speed'
                      ? 'bg-indigo-600/30 border-indigo-500 text-indigo-200 font-semibold'
                      : 'bg-neutral-950 border-neutral-800 text-neutral-400 hover:text-neutral-200'
                  }`}
                >
                  By Speed (km/h)
                </button>
              </div>
            </div>

            {/* GPS Accuracy Filter Threshold Slider */}
            <div className="p-3 bg-neutral-900 border border-neutral-800 rounded-lg space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-neutral-200">Max Accuracy Filter</span>
                <span className="font-mono text-indigo-400 font-medium">{accuracyThreshold} meters</span>
              </div>
              <input
                type="range"
                min="10"
                max="100"
                step="5"
                value={accuracyThreshold}
                onChange={e => onChangeAccuracy(parseInt(e.target.value))}
                className="w-full h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
              />
              <p className="text-[10px] text-neutral-500">
                Points with horizontal accuracy &gt; {accuracyThreshold}m will be discarded to remove GPS jitter.
              </p>
            </div>

            {/* Stops Layer Toggle */}
            <div className="p-3 bg-neutral-900 border border-neutral-800 rounded-lg flex items-center justify-between">
              <div>
                <span className="text-xs font-semibold text-neutral-200 block">Show Stationary Stops</span>
                <span className="text-[10px] text-neutral-500">Points stationary for 3+ records</span>
              </div>
              <button
                type="button"
                onClick={onToggleStops}
                className={`w-10 h-5 rounded-full transition-colors relative cursor-pointer ${
                  showStops ? 'bg-indigo-600' : 'bg-neutral-800'
                }`}
              >
                <span
                  className={`block w-3.5 h-3.5 rounded-full bg-white transition-transform ${
                    showStops ? 'translate-x-5' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            {/* Trip Mode Filter Badges */}
            <div className="p-3 bg-neutral-900 border border-neutral-800 rounded-lg space-y-2">
              <span className="text-xs font-semibold text-neutral-200 block">Filter By Mode</span>
              <div className="flex flex-wrap gap-1.5">
                {availableModes.map(mode => {
                  const isFilteredOut = filteredModes.length > 0 && !filteredModes.includes(mode);
                  const modeColor = getModeColor(mode);

                  return (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => onToggleModeFilter(mode)}
                      style={{
                        backgroundColor: !isFilteredOut ? `${modeColor}22` : '#171717',
                        borderColor: !isFilteredOut ? modeColor : '#333333',
                        color: !isFilteredOut ? modeColor : '#737373',
                      }}
                      className="px-2.5 py-1 rounded-md text-xs font-medium border flex items-center gap-1.5 transition cursor-pointer capitalize"
                    >
                      <span
                        className="w-2 h-2 rounded-full"
                        style={{ backgroundColor: modeColor }}
                      />
                      <span>{mode}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Mode Color Legend (Footer) */}
      <div className="p-3 border-t border-neutral-800/80 bg-neutral-900/60 text-[11px]">
        <div className="text-[10px] text-neutral-500 uppercase font-semibold tracking-wider mb-1.5">
          Legend
        </div>
        <div className="grid grid-cols-2 gap-x-2 gap-y-1">
          {Object.entries(MODE_COLORS)
            .filter(([k]) => ['walking', 'driving', 'cycling', 'running'].includes(k))
            .map(([mode, conf]) => (
              <div key={mode} className="flex items-center gap-1.5 text-neutral-300">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: conf.hex }} />
                <span className="capitalize">{conf.label}</span>
              </div>
            ))}
        </div>
      </div>
    </aside>
  );
};
