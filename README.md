# 🗺️ Somaari Trip — Self-Hosted GPS Route Viewer

Somaari Trip is a self-hosted, lightweight GPS route viewer tailored for personal trip logs collected by **Overland iOS**, which posts straight to the app. It runs statelessly on flat daily CSV files with no database requirements, rendering trips in **IST (Asia/Kolkata, UTC+5:30)** on OpenStreetMap tiles with zero external API key dependencies.

![Somaari Trip: day list, trip stats and routes on the map (sample data)](docs/images/overview.jpg)

## 📖 Guide

**[docs/GUIDE.md](docs/GUIDE.md)** covers everything needed to run it:
1. [Installation](docs/GUIDE.md#1-installation): requirements, Docker setup, who can reach it, updating, trying it with sample data
2. [Configuration](docs/GUIDE.md#2-configuration): settings, login, Overland on the iPhone, data files and CSV format
3. [Using the app](docs/GUIDE.md#3-using-the-app): days and ranges, trips, stops, display settings, phones
4. [Troubleshooting](docs/GUIDE.md#4-troubleshooting)

---

## 🛠️ Features

- **OpenStreetMap & CartoDB Dark Tiles**: Zero external API keys needed. In Docker, the server fetches and caches tiles (`/tiles/`, `tile-cache` volume) so the tile servers never see your browser or which areas you view.
- **Polyline Color Modes**: Color by trip mode or dynamic speed gradient (green → yellow → red).
- **Proximity Clustered Stationary Stops**: Automatically detects 3+ consecutive stationary records with WiFi SSID & battery info.
- **IST Timezone Native**: All timestamps and time spans converted to Indian Standard Time.
- **Small & Memory Bounded**: one ~120 MB image and one process (~60–100 MB RSS), no database; caches are capped so memory doesn't grow with history.

---

## 🔄 How It Works

Everything runs in **one container, one Node process** (Express; no nginx, no database), published on `SOMAARI_TRIP_BIND:SOMAARI_TRIP_PORT` (default `127.0.0.1:18473`).

1. **Phone (Overland iOS)** logs GPS points in the background and POSTs them in batches (JSON `locations` array) to `/api/overland`, with a bearer token. It reaches the server over a private network (ZeroTier/Tailscale/LAN), never the open internet.
2. **Ingest** (`/api/overland`, only when `OVERLAND_TOKEN` is set; token instead of basic auth, 5 MB body limit, own rate limit) buckets each point by its **IST** date and appends rows to `trips_YYYY-MM-DD.csv`, writing the header for a new file. It replies only after the rows are on disk; on failure it returns 500 so Overland keeps the batch and retries.
3. **Storage** is plain CSV files on disk, one per IST day: no database.
4. **API**:
   - Parses CSVs, drops bad rows and points with accuracy worse than 50 m (adjustable), and treats `speed=-1` as unknown rather than stopped. Day summaries are cached per file until it changes, and parsed points sit in a capped LRU (~100k points), so memory doesn't grow with history.
   - Groups points by `trip_id`, splits trips on gaps over 5 minutes, detects stops (3+ consecutive stationary points), and computes distance, duration and speeds.
   - Days are **IST days**, and files are named by IST date, so day D is read from file D alone. A trip crossing midnight is split between both days.
   - Serves `/api/days` (sidebar summaries), `/api/trips?date=` or `?from=&to=` (GeoJSON routes + stops, gzipped when large) and `/api/health`.
5. **Web**:
   - Basic auth (`AUTH_USER` / `AUTH_HASH` in `.env`, scrypt) on everything except `/api/overland` and `/api/health`.
   - Serves the built React app (precompressed `.br`/`.gz`; hashed assets cached `immutable`) and proxies `/tiles/` to CARTO/OSM with a disk cache (`tile-cache` volume, 1 GB cap).
   - Security headers, a strict CSP (`'self'` only) and per-IP rate limits.
6. **Browser** (React + Leaflet) loads the day list, then that day's trips and stops, and draws routes coloured by mode or speed (grey where speed is unknown) with stop markers and stats, all in IST. It only ever talks to your server.

---

## 🔒 Security notes

There's no reverse proxy in front: Express does the login, limits and headers itself. For what's exposed on your network, see [Who can reach it](docs/GUIDE.md#who-can-reach-it).
- **Login**: basic auth is checked before any route that reads data, with a constant-time compare. Wrong passwords have their own rate limit, checked before scrypt runs, and a header that verified once is remembered so scrypt runs once per session. In production the app refuses to start without `AUTH_USER`/`AUTH_HASH`.
- **Limits**: per-IP token buckets (10 r/s burst 20 for `/api/`, 2 r/s burst 10 for `/api/overland`), 5 MB Overland body limit, server timeouts (headers 10 s, request 30 s, keep-alive 5 s).
- **Tile proxy**: allow-listed styles and integer `z/x/y` only, so it can't be used as an open proxy; only `User-Agent` and `Accept` go upstream, never browser headers.
- **Container**: runs as uid `INGEST_UID` (default 1001) with a read-only root filesystem, all capabilities dropped and `no-new-privileges`. The data dir is writable because ingest appends to it; only the CSV append code writes there, and dates are regex-validated before any file path is built.

---

## 🔌 API Endpoints

- **`GET /api/days`**
  - Scans `DATA_DIR` for `trips_YYYY-MM-DD.csv` files.
  - Returns date, point count, total distance, duration, trip counts, and modes.

- **`GET /api/trips?date=YYYY-MM-DD`**
  - Parses that day's CSV and returns GeoJSON LineStrings per `trip_id` and Point stops.
  - Segments are broken wherever the time gap between consecutive points exceeds 5 minutes.

- **`GET /api/trips?from=YYYY-MM-DD&to=YYYY-MM-DD`**
  - Merges multiple daily files for multi-day route visualization.

- **`GET /api/trips?...&max_accuracy=50`**
  - Filters out points where horizontal accuracy exceeds the threshold (default 50m).

- **`POST /api/overland`** (only when `OVERLAND_TOKEN` is set; bearer token instead of the login)
  - Overland batch upload, rows appended to the day's CSV ([format](docs/GUIDE.md#data-files)). 401 without the token, 400 if `locations` isn't an array, `{"result":"ok"}` once appended.

---

## 🧑‍💻 Development

```bash
npm ci
SEED_SAMPLE_DATA=true npm run dev   # API + Vite on 127.0.0.1:3000, sample data in ./data, no login
npm run lint                        # tsc --noEmit
npm test                            # vitest
npm run build                       # frontend + bundled server into dist/
```

The dev server reads `./data` and fetches map tiles directly; production serves `dist/` and proxies tiles. `AUTH_USER`/`AUTH_HASH` in the shell turn the login on in dev too. Screenshots in `docs/images/` are taken from sample data only.

---

## 📄 License

MIT, see [LICENSE](LICENSE).
