import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import { TripFeature, StopFeature, TripSegment } from '../../shared/types.ts';
import { formatToIST, formatDuration, formatDistance, getModeColor, getSpeedColor } from '../utils/time.ts';
import { escapeHtml } from '../utils/html.ts';
import { Navigation, Compass } from 'lucide-react';

interface MapViewerProps {
  trips: TripFeature[];
  stops: StopFeature[];
  colorMode: 'mode' | 'speed';
  showStops: boolean;
  selectedTripId: string | null;
  onSelectTrip: (tripId: string | null) => void;
}

function segmentLatLngs(seg: TripSegment): L.LatLngTuple[] {
  return seg.points.map(p => [p.lat, p.lon]);
}

// In production the server proxies and caches tiles under /tiles/osm/ (server/tileProxy.ts) so the
// tile server never sees the browser. The dev server has no proxy, so it fetches them directly.
const OSM_TILE_URL = import.meta.env.DEV
  ? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
  : '/tiles/osm/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export const MapViewer: React.FC<MapViewerProps> = ({
  trips,
  stops,
  colorMode,
  showStops,
  selectedTripId,
  onSelectTrip,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const polylinesGroupRef = useRef<L.FeatureGroup | null>(null);
  const stopsGroupRef = useRef<L.FeatureGroup | null>(null);
  const markersGroupRef = useRef<L.FeatureGroup | null>(null);
  const tripLinesRef = useRef<Map<string, L.Polyline[]>>(new Map());

  // Initialize Map
  useEffect(() => {
    if (!mapContainerRef.current || mapInstanceRef.current) return;

    const map = L.map(mapContainerRef.current, {
      center: [12.9716, 77.5946], // Default center
      zoom: 13,
      zoomControl: false,
      preferCanvas: true, // one canvas instead of an SVG element per polyline
    });

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    L.tileLayer(OSM_TILE_URL, { attribution: OSM_ATTRIBUTION, maxZoom: 19 }).addTo(map);

    const polylinesGroup = L.featureGroup().addTo(map);
    const stopsGroup = L.featureGroup().addTo(map);
    const markersGroup = L.featureGroup().addTo(map);

    polylinesGroupRef.current = polylinesGroup;
    stopsGroupRef.current = stopsGroup;
    markersGroupRef.current = markersGroup;
    mapInstanceRef.current = map;

    return () => {
      map.remove();
      mapInstanceRef.current = null;
    };
  }, []);

  // Render Polylines and Markers
  useEffect(() => {
    const map = mapInstanceRef.current;
    const polyGroup = polylinesGroupRef.current;
    const markerGroup = markersGroupRef.current;
    if (!map || !polyGroup || !markerGroup) return;

    polyGroup.clearLayers();
    markerGroup.clearLayers();
    tripLinesRef.current = new Map();

    const allCoords: L.LatLngExpression[] = [];

    trips.forEach(trip => {
      const baseColor = getModeColor(trip.properties.trip_mode);
      const tripLines: L.Polyline[] = [];
      tripLinesRef.current.set(trip.properties.trip_id, tripLines);

      // Render each segment of the trip (segments exist due to >5min gap breaking)
      trip.segments.forEach((seg, segIdx) => {
        if (seg.points.length < 2) return;

        const latLngs = segmentLatLngs(seg);
        latLngs.forEach(c => allCoords.push(c));

        if (colorMode === 'mode') {
          // Single colored polyline for segment
          const line = L.polyline(latLngs, {
            color: baseColor,
            weight: 4,
            opacity: 0.85,
            lineCap: 'round',
            lineJoin: 'round',
          });

          line.on('click', () => {
            onSelectTrip(trip.properties.trip_id);
          });

          // Custom popup formatted in IST
          const popupContent = `
            <div style="font-family: inherit; font-size: 13px; line-height: 1.5; color: #f5f5f5;">
              <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; border-bottom: 1px solid #333; padding-bottom: 6px;">
                <span style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-weight: 600; font-size: 11px; text-transform: uppercase; background: ${baseColor}33; color: ${baseColor}; border: 1px solid ${baseColor}66;">
                  ${escapeHtml(trip.properties.trip_mode)}
                </span>
                <span style="color: #a3a3a3; font-size: 11px;">${escapeHtml(trip.properties.trip_id)}</span>
              </div>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 8px;">
                <div>
                  <div style="color: #888; font-size: 11px;">Distance</div>
                  <div style="font-weight: 600; font-size: 14px;">${formatDistance(trip.properties.distance_m)}</div>
                </div>
                <div>
                  <div style="color: #888; font-size: 11px;">Duration</div>
                  <div style="font-weight: 600; font-size: 14px;">${formatDuration(trip.properties.duration_s)}</div>
                </div>
                <div>
                  <div style="color: #888; font-size: 11px;">Avg Speed</div>
                  <div style="font-weight: 600;">${trip.properties.avg_speed_kmh} km/h</div>
                </div>
                <div>
                  <div style="color: #888; font-size: 11px;">Max Speed</div>
                  <div style="font-weight: 600;">${trip.properties.max_speed_kmh} km/h</div>
                </div>
              </div>
              <div style="border-top: 1px solid #262626; padding-top: 6px; font-size: 11px; color: #a3a3a3;">
                <div><strong>Start (IST):</strong> ${formatToIST(trip.properties.start_time, { short: true })}</div>
                <div><strong>End (IST):</strong> ${formatToIST(trip.properties.end_time, { short: true })}</div>
                ${trip.properties.segments_count > 1 ? `<div style="color: #f59e0b; margin-top: 4px;">⚡ Split into ${trip.properties.segments_count} segments (>5m gap)</div>` : ''}
              </div>
            </div>
          `;
          line.bindPopup(popupContent);
          polyGroup.addLayer(line);
          tripLines.push(line);
        } else {
          // Colour each pair of points by speed, merging consecutive same-colour pairs into one polyline
          let run: { color: string; latLngs: L.LatLngTuple[]; speeds: number[]; start: string; end: string } | null = null;
          const flushRun = () => {
            if (!run) return;
            const speedLine = L.polyline(run.latLngs, {
              color: run.color,
              weight: 4.5,
              opacity: 0.9,
              lineCap: 'round',
            });
            speedLine.on('click', () => {
              onSelectTrip(trip.properties.trip_id);
            });
            const speedText = run.speeds.length > 0
              ? `${((run.speeds.reduce((a, v) => a + v, 0) / run.speeds.length) * 3.6).toFixed(1)} km/h avg`
              : 'unknown';
            speedLine.bindTooltip(
              `Speed: ${speedText} | ${formatToIST(run.start, { short: true })} – ${formatToIST(run.end, { short: true })}`,
              { sticky: true }
            );
            polyGroup.addLayer(speedLine);
            tripLines.push(speedLine);
            run = null;
          };

          for (let pIdx = 0; pIdx < seg.points.length - 1; pIdx++) {
            const p1 = seg.points[pIdx];
            const p2 = seg.points[pIdx + 1];
            // Average the known speeds; grey only if both are unknown
            const avgMps =
              p1.speed_mps === undefined ? p2.speed_mps
              : p2.speed_mps === undefined ? p1.speed_mps
              : (p1.speed_mps + p2.speed_mps) / 2;
            const speedColor = getSpeedColor(avgMps);

            if (run && run.color !== speedColor) flushRun();
            if (!run) {
              run = { color: speedColor, latLngs: [[p1.lat, p1.lon]], speeds: [], start: p1.timestamp, end: p1.timestamp };
            }
            run.latLngs.push([p2.lat, p2.lon]);
            run.end = p2.timestamp;
            if (avgMps !== undefined) run.speeds.push(avgMps);
          }
          flushRun();
        }

        // Add start / end circular markers for the trip
        if (segIdx === 0) {
          const startPt = latLngs[0];
          const startIcon = L.divIcon({
            className: 'custom-start-marker',
            html: `<div style="background-color: #10B981; width: 12px; height: 12px; border-radius: 50%; border: 2px solid #ffffff; box-shadow: 0 0 8px rgba(16,185,129,0.8);"></div>`,
            iconSize: [12, 12],
            iconAnchor: [6, 6],
          });
          const startMarker = L.marker(startPt, { icon: startIcon });
          startMarker.bindTooltip(`Start: ${escapeHtml(trip.properties.trip_mode)} (${formatToIST(trip.properties.start_time, { short: true })})`);
          markerGroup.addLayer(startMarker);
        }

        if (segIdx === trip.segments.length - 1) {
          const endPt = latLngs[latLngs.length - 1];
          const endIcon = L.divIcon({
            className: 'custom-end-marker',
            html: `<div style="background-color: #EF4444; width: 12px; height: 12px; border-radius: 50%; border: 2px solid #ffffff; box-shadow: 0 0 8px rgba(239,68,68,0.8);"></div>`,
            iconSize: [12, 12],
            iconAnchor: [6, 6],
          });
          const endMarker = L.marker(endPt, { icon: endIcon });
          endMarker.bindTooltip(`End: ${formatToIST(trip.properties.end_time, { short: true })}`);
          markerGroup.addLayer(endMarker);
        }
      });
    });

    // Auto-fit bounds if we have coordinates
    if (allCoords.length > 0) {
      const bounds = L.latLngBounds(allCoords);
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16, animate: true });
    }
  }, [trips, colorMode]);

  // Highlight the selected trip without rebuilding layers (runs after a rebuild too)
  useEffect(() => {
    const baseWeight = colorMode === 'mode' ? 4 : 4.5;
    const baseOpacity = colorMode === 'mode' ? 0.85 : 0.9;
    tripLinesRef.current.forEach((lines, tripId) => {
      const isSelected = tripId === selectedTripId;
      lines.forEach(line => {
        line.setStyle({
          weight: isSelected ? 6 : baseWeight,
          opacity: isSelected ? 1 : baseOpacity,
        });
        if (isSelected) line.bringToFront();
      });
    });
  }, [trips, colorMode, selectedTripId]);

  // Zoom to the selected trip
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !selectedTripId) return;
    const trip = trips.find(t => t.properties.trip_id === selectedTripId);
    if (!trip) return;
    const coords: L.LatLngExpression[] = [];
    trip.segments.forEach(s => s.points.forEach(p => coords.push([p.lat, p.lon])));
    if (coords.length > 0) {
      map.fitBounds(L.latLngBounds(coords), { padding: [40, 40], maxZoom: 17, animate: true });
    }
  }, [selectedTripId]);

  // Render Stop Points Layer with lightweight proximity clustering
  useEffect(() => {
    const map = mapInstanceRef.current;
    const stopsGroup = stopsGroupRef.current;
    if (!map || !stopsGroup) return;

    stopsGroup.clearLayers();
    if (!showStops || stops.length === 0) return;

    // Proximity grouping for dense stops
    const clusters: { center: [number, number]; items: StopFeature[] }[] = [];
    const PROXIMITY_DEG = 0.0015; // ~150 meters

    stops.forEach(stop => {
      const lat = stop.properties.lat;
      const lon = stop.properties.lon;
      let matchedCluster = clusters.find(c => {
        const dLat = Math.abs(c.center[0] - lat);
        const dLon = Math.abs(c.center[1] - lon);
        return dLat < PROXIMITY_DEG && dLon < PROXIMITY_DEG;
      });

      if (matchedCluster) {
        matchedCluster.items.push(stop);
      } else {
        clusters.push({ center: [lat, lon], items: [stop] });
      }
    });

    clusters.forEach(cluster => {
      const count = cluster.items.length;
      const isClustered = count > 1;

      const size = isClustered ? Math.min(32, 20 + count * 3) : 18;
      const iconHtml = isClustered
        ? `<div style="display: flex; align-items: center; justify-content: center; width: ${size}px; height: ${size}px; border-radius: 50%; background: #6366F1; color: white; font-weight: 700; font-size: 11px; border: 2px solid #ffffff; box-shadow: 0 0 10px rgba(99,102,241,0.7);">
            ${count}
          </div>`
        : `<div style="display: flex; align-items: center; justify-content: center; width: ${size}px; height: ${size}px; border-radius: 50%; background: #8B5CF6; color: white; border: 2px solid #ffffff; box-shadow: 0 0 8px rgba(139,92,246,0.7);">
            <div style="width: 6px; height: 6px; border-radius: 50%; background: white;"></div>
          </div>`;

      const stopIcon = L.divIcon({
        className: 'custom-stop-icon',
        html: iconHtml,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      });

      const marker = L.marker(cluster.center, { icon: stopIcon });

      // Popup Content for Stops
      const popupHtml = `
        <div style="font-family: inherit; font-size: 13px; line-height: 1.4; color: #f5f5f5;">
          <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 6px; border-bottom: 1px solid #333; padding-bottom: 4px;">
            <span style="background: #8B5CF6; color: white; padding: 2px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; text-transform: uppercase;">
              ${isClustered ? `${count} Stationary Stops` : 'Stationary Stop'}
            </span>
          </div>
          <div style="max-height: 180px; overflow-y: auto; padding-right: 4px;">
            ${cluster.items
              .map(
                (item, idx) => `
              <div style="${idx > 0 ? 'margin-top: 8px; padding-top: 8px; border-top: 1px dashed #333;' : ''}">
                <div style="font-weight: 600; color: #a78bfa;">⏱️ ${item.properties.duration_formatted}</div>
                <div style="font-size: 11px; color: #d4d4d4; margin-top: 2px;">
                  <div><strong>From:</strong> ${formatToIST(item.properties.start_time, { short: true })}</div>
                  <div><strong>To:</strong> ${formatToIST(item.properties.end_time, { short: true })}</div>
                  ${item.properties.wifi_ssid ? `<div style="color: #38bdf8;">📶 WiFi: ${escapeHtml(item.properties.wifi_ssid)}</div>` : ''}
                  ${item.properties.battery_level !== undefined ? `<div>🔋 Battery: ${Math.round(item.properties.battery_level * 100)}%</div>` : ''}
                  <div style="color: #888;">📍 Points: ${item.properties.point_count} stationary</div>
                </div>
              </div>
            `
              )
              .join('')}
          </div>
        </div>
      `;

      marker.bindPopup(popupHtml);
      stopsGroup.addLayer(marker);
    });
  }, [stops, showStops]);

  // Recenter Map
  const handleRecenter = () => {
    if (!mapInstanceRef.current) return;
    const allCoords: L.LatLngExpression[] = [];
    trips.forEach(t => t.segments.forEach(s => s.points.forEach(p => allCoords.push([p.lat, p.lon]))));
    if (allCoords.length > 0) {
      mapInstanceRef.current.fitBounds(L.latLngBounds(allCoords), { padding: [40, 40], maxZoom: 16 });
    }
  };

  return (
    <div className="relative w-full h-full bg-neutral-950 overflow-hidden flex flex-col" id="map-container-wrapper">
      <div ref={mapContainerRef} className="w-full h-full z-0" id="leaflet-map-canvas" />

      {/* Floating Map Controls */}
      <div className="absolute top-4 right-4 z-[400] flex flex-col gap-2">
        {/* Recenter / Fit button */}
        <button
          id="btn-recenter-map"
          type="button"
          onClick={handleRecenter}
          className="p-2.5 bg-neutral-900/90 hover:bg-neutral-800 text-neutral-200 hover:text-white rounded-lg border border-neutral-700/60 shadow-lg backdrop-blur-md transition-all flex items-center justify-center cursor-pointer"
          title="Fit to Trips"
        >
          <Navigation className="w-4 h-4" />
        </button>
      </div>

      {/* Speed Legend Overlay when speed colorMode is active */}
      {colorMode === 'speed' && (
        <div
          id="speed-legend-overlay"
          className="absolute bottom-6 left-6 z-[400] bg-neutral-900/90 border border-neutral-800 rounded-lg px-3.5 py-2.5 shadow-xl backdrop-blur-md text-xs text-neutral-200 pointer-events-auto"
        >
          <div className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Compass className="w-3.5 h-3.5 text-indigo-400" />
            <span>Speed (km/h)</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-neutral-400">0</span>
            <div className="h-2.5 w-36 rounded-full bg-gradient-to-r from-emerald-500 via-yellow-500 via-orange-500 to-red-500 shadow-inner" />
            <span className="text-[11px] text-neutral-400">80+</span>
          </div>
          <div className="flex justify-between text-[10px] text-neutral-500 mt-1 px-1">
            <span>Walk</span>
            <span>Cycle</span>
            <span>Drive</span>
            <span>Fast</span>
          </div>
        </div>
      )}
    </div>
  );
};
