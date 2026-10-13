import { useState, useEffect, useCallback, useMemo } from 'react';
import { DaySummary, TripsResponse, TripFeature, StopFeature } from '../shared/types.ts';
import { Sidebar } from './components/Sidebar.tsx';
import { MapViewer } from './components/MapViewer.tsx';
import { TripStatsBar } from './components/TripStatsBar.tsx';
import { Menu, X } from 'lucide-react';

const EMPTY_TRIPS: TripsResponse = {
  type: 'FeatureCollection',
  features: [],
  stops: { type: 'FeatureCollection', features: [] },
  summary: {
    from: '',
    to: '',
    total_trips: 0,
    total_distance_m: 0,
    total_distance_km: 0,
    total_duration_s: 0,
    total_points: 0,
    total_stops: 0,
    modes: [],
    max_speed_kmh: 0,
    avg_speed_kmh: 0,
  },
};

const ACCURACY_DEBOUNCE_MS = 300;

// Recompute the summary for a mode-filtered subset (mirrors server.ts /api/trips)
function summarizeTrips(
  trips: TripFeature[],
  stops: StopFeature[],
  base: TripsResponse['summary']
): TripsResponse['summary'] {
  let total_distance_m = 0;
  let total_duration_s = 0;
  let total_points = 0;
  let max_speed_mps = 0;
  let movingSum = 0;
  let movingCount = 0;
  const modeSet = new Set<string>();

  for (const t of trips) {
    total_distance_m += t.properties.distance_m;
    total_duration_s += t.properties.duration_s;
    total_points += t.properties.point_count;
    max_speed_mps = Math.max(max_speed_mps, t.properties.max_speed_mps);
    modeSet.add(t.properties.trip_mode);
    for (const seg of t.segments) {
      for (const p of seg.points) {
        if (p.speed_mps !== undefined && p.speed_mps > 0.5) {
          movingSum += p.speed_mps;
          movingCount++;
        }
      }
    }
  }
  const avg_speed_mps = movingCount > 0 ? movingSum / movingCount : 0;

  return {
    from: base.from,
    to: base.to,
    total_trips: trips.length,
    total_distance_m,
    total_distance_km: +(total_distance_m / 1000).toFixed(2),
    total_duration_s,
    total_points,
    total_stops: stops.length,
    modes: Array.from(modeSet),
    max_speed_kmh: +(max_speed_mps * 3.6).toFixed(1),
    avg_speed_kmh: +(avg_speed_mps * 3.6).toFixed(1),
  };
}

export default function App() {
  const [days, setDays] = useState<DaySummary[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [selectedRange, setSelectedRange] = useState<{ from: string; to: string } | null>(null);
  const [selectionMode, setSelectionMode] = useState<'single' | 'range'>('single');

  const [tripsData, setTripsData] = useState<TripsResponse>(EMPTY_TRIPS);

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);
  const [colorMode, setColorMode] = useState<'mode' | 'speed'>('mode');
  const [accuracyThreshold, setAccuracyThreshold] = useState<number>(50);
  const [queryAccuracy, setQueryAccuracy] = useState<number>(50);
  const [showStops, setShowStops] = useState<boolean>(true);
  const [filteredModes, setFilteredModes] = useState<string[]>([]);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState<boolean>(false);
  const [refreshKey, setRefreshKey] = useState<number>(0);

  // Fetch available days
  const fetchDays = useCallback(async () => {
    try {
      setIsLoading(true);
      const res = await fetch('/api/days');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.days && Array.isArray(data.days)) {
        setDays(data.days);
        if (data.days.length > 0) {
          setSelectedDate(prev => prev || data.days[0].date);
        }
      }
    } catch (err) {
      console.error('Failed to fetch days:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDays();
  }, [fetchDays]);

  // Debounce the accuracy slider so dragging doesn't fire a request per step
  useEffect(() => {
    const timer = setTimeout(() => setQueryAccuracy(accuracyThreshold), ACCURACY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [accuracyThreshold]);

  // Fetch trips for selected date / range; abort stale requests
  const tripsQuery =
    selectionMode === 'single'
      ? selectedDate
        ? `date=${encodeURIComponent(selectedDate)}&max_accuracy=${queryAccuracy}`
        : null
      : selectedRange
      ? `from=${encodeURIComponent(selectedRange.from)}&to=${encodeURIComponent(selectedRange.to)}&max_accuracy=${queryAccuracy}`
      : null;

  useEffect(() => {
    if (!tripsQuery) {
      setTripsData(EMPTY_TRIPS);
      return;
    }

    const controller = new AbortController();
    setIsLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/trips?${tripsQuery}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: TripsResponse = await res.json();
        setTripsData(data);
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error('Failed to fetch trips:', err);
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    })();

    return () => controller.abort();
  }, [tripsQuery, refreshKey]);

  const handleRefresh = () => {
    fetchDays();
    setRefreshKey(k => k + 1);
  };

  const handleSelectDate = (date: string) => {
    setSelectedDate(date);
    setSelectedTripId(null);
    setMobileSidebarOpen(false);
  };

  const handleSelectRange = (range: { from: string; to: string } | null) => {
    setSelectedRange(range);
    setSelectedTripId(null);
  };

  const handleToggleModeFilter = (mode: string) => {
    const next = filteredModes.includes(mode)
      ? filteredModes.filter(m => m !== mode)
      : [...filteredModes, mode];
    setFilteredModes(next);

    const selected = tripsData.features.find(f => f.properties.trip_id === selectedTripId);
    if (selected && next.length > 0 && !next.includes(selected.properties.trip_mode)) {
      setSelectedTripId(null);
    }
  };

  // Apply the mode filter to everything shown: map, stops, stats, trip list
  const { visibleTrips, visibleStops, visibleSummary } = useMemo(() => {
    if (filteredModes.length === 0) {
      return {
        visibleTrips: tripsData.features,
        visibleStops: tripsData.stops.features,
        visibleSummary: tripsData.summary,
      };
    }
    const trips = tripsData.features.filter(t => filteredModes.includes(t.properties.trip_mode));
    const stops = tripsData.stops.features.filter(s => filteredModes.includes(s.properties.trip_mode));
    return {
      visibleTrips: trips,
      visibleStops: stops,
      visibleSummary: summarizeTrips(trips, stops, tripsData.summary),
    };
  }, [tripsData, filteredModes]);

  const availableModes = useMemo(
    () =>
      Array.from(
        new Set<string>(days.flatMap(d => d.modes || []).concat(tripsData.features.map(t => t.properties.trip_mode)))
      ).filter(Boolean),
    [days, tripsData]
  );

  // Date label formatting
  const dateLabel =
    selectionMode === 'single'
      ? selectedDate || 'No date selected'
      : selectedRange
      ? `${selectedRange.from} → ${selectedRange.to}`
      : 'Select date range';

  const selectedTrip = visibleTrips.find(f => f.properties.trip_id === selectedTripId);
  return (
    <div className="flex h-screen w-screen bg-neutral-950 text-neutral-100 overflow-hidden font-sans">
      {/* Mobile Menu Button: the stats bar and sidebar header reserve pl-14 for it below md */}
      <button
        type="button"
        onClick={() => setMobileSidebarOpen(!mobileSidebarOpen)}
        className="md:hidden fixed top-3 left-3 z-[600] p-2 bg-neutral-900 border border-neutral-800 rounded-lg text-neutral-200 shadow-xl"
        title="Toggle Menu"
      >
        {mobileSidebarOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
      </button>

      {/* Sidebar - Desktop & Mobile Drawer */}
      <div
        className={`fixed md:relative inset-y-0 left-0 z-[500] transform transition-transform duration-200 md:translate-x-0 ${
          mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <Sidebar
          days={days}
          selectedDate={selectedDate}
          selectedRange={selectedRange}
          selectionMode={selectionMode}
          onSelectDate={handleSelectDate}
          onSelectRange={handleSelectRange}
          onSetSelectionMode={setSelectionMode}
          colorMode={colorMode}
          onChangeColorMode={setColorMode}
          accuracyThreshold={accuracyThreshold}
          onChangeAccuracy={setAccuracyThreshold}
          showStops={showStops}
          onToggleStops={() => setShowStops(!showStops)}
          trips={visibleTrips}
          availableModes={availableModes}
          selectedTripId={selectedTripId}
          onSelectTrip={setSelectedTripId}
          filteredModes={filteredModes}
          onToggleModeFilter={handleToggleModeFilter}
          isLoading={isLoading}
          onRefreshDays={handleRefresh}
        />
      </div>

      {/* Main Map View Area */}
      <main className="flex-1 flex flex-col h-full relative overflow-hidden">
        {/* Top Summary Bar */}
        <TripStatsBar
          summary={visibleSummary}
          dateLabel={dateLabel}
          selectedTripMode={selectedTrip?.properties.trip_mode}
        />

        {/* Map Canvas */}
        <div className="flex-1 relative w-full h-full">
          <MapViewer
            trips={visibleTrips}
            stops={visibleStops}
            colorMode={colorMode}
            showStops={showStops}
            selectedTripId={selectedTripId}
            onSelectTrip={setSelectedTripId}
          />
        </div>
      </main>
    </div>
  );
}
