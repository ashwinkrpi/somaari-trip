export interface TripPoint {
  timestamp: string;
  trip_id: string;
  lat: number;
  lon: number;
  speed_mps?: number; // undefined when Overland reports -1 (unknown)
  speed_kmh?: number;
  speed_accuracy?: number;
  course?: number;
  course_accuracy?: number;
  altitude_m?: number;
  vertical_accuracy?: number;
  accuracy_m: number;
  battery_level?: number;
  battery_state?: string;
  motion?: string;
  wifi_ssid?: string;
  device_id?: string;
  trip_distance_m: number;
  trip_mode: string;
  trip_start?: string;
}

// Points are sent once per segment; Leaflet coordinates are derived from them
export interface TripSegment {
  points: {
    lat: number;
    lon: number;
    speed_mps?: number;
    timestamp: string;
  }[];
}

export interface TripFeatureProperties {
  trip_id: string;
  trip_mode: string;
  start_time: string; // ISO UTC
  end_time: string; // ISO UTC
  duration_s: number;
  distance_m: number;
  distance_km: number;
  avg_speed_mps: number;
  avg_speed_kmh: number;
  max_speed_mps: number;
  max_speed_kmh: number;
  point_count: number;
  battery_start?: number;
  battery_end?: number;
  segments_count: number;
}

export interface TripFeature {
  type: 'Feature';
  id: string;
  properties: TripFeatureProperties;
  segments: TripSegment[]; // Split on >5 min gaps
}

export interface StopFeatureProperties {
  id: string;
  trip_id: string;
  trip_mode: string;
  start_time: string;
  end_time: string;
  duration_s: number;
  duration_formatted: string;
  point_count: number;
  wifi_ssid?: string;
  battery_level?: number;
  motion?: string;
  lat: number;
  lon: number;
}

export interface StopFeature {
  type: 'Feature';
  id: string;
  properties: StopFeatureProperties;
  geometry: {
    type: 'Point';
    coordinates: [number, number]; // [lon, lat]
  };
}

export interface DaySummary {
  date: string; // YYYY-MM-DD
  point_count: number;
  total_distance_m: number;
  total_distance_km: number;
  duration_s: number;
  trip_count: number;
  modes: string[];
  stops_count: number;
}

export interface TripsResponse {
  type: 'FeatureCollection';
  features: TripFeature[];
  stops: {
    type: 'FeatureCollection';
    features: StopFeature[];
  };
  summary: {
    from: string;
    to: string;
    total_trips: number;
    total_distance_m: number;
    total_distance_km: number;
    total_duration_s: number;
    total_points: number;
    total_stops: number;
    modes: string[];
    max_speed_kmh: number;
    avg_speed_kmh: number;
  };
}
