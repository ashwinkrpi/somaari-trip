# 🗺️ Somaari Trip — Self-Hosted GPS Route Viewer

Somaari Trip is a self-hosted, lightweight GPS route viewer tailored for personal trip logs collected by **Overland iOS**, which posts straight to the app. It runs statelessly on flat daily CSV files with no database requirements, rendering trips in **IST (Asia/Kolkata, UTC+5:30)** on OpenStreetMap tiles with zero external API key dependencies.

---

## 🔄 How It Works

Everything runs in **one container, one Node process** (Express; no nginx, no database), published on `SOMAARI_TRIP_BIND:SOMAARI_TRIP_PORT` (default `127.0.0.1:18473`).

1. **Phone (Overland iOS)** logs GPS points in the background and POSTs them in batches (JSON `locations` array) to `/api/overland`, with a bearer token. It reaches the server over a private network (ZeroTier/Tailscale/LAN), never the open internet.
2. **Ingest** (`/api/overland`, only when `OVERLAND_TOKEN` is set; token instead of basic auth, 5 MB body limit, own rate limit) buckets each point by its **IST** date and appends rows to `trips_YYYY-MM-DD.csv`, writing the header for a new file. It replies only after the rows are on disk; on failure it returns 500 so Overland keeps the batch and retries.
3. **Storage** is plain CSV files on disk: no database. Encrypt the directory at rest (gocryptfs, LUKS) if the machine could be physically accessed.
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

**Deploy:** `docker compose up -d --build`. **Dev:** `npm run dev` runs API + Vite on `127.0.0.1:3000`, reading `./data` and fetching tiles directly (no login unless `AUTH_USER`/`AUTH_HASH` are set). **Checks:** `npm run lint`, `npm test`.

### 🔒 Security notes

nginx used to sit in front of the app; its job now lives in Express:
- **Login**: basic auth is checked before any route that reads data, with a constant-time compare. Wrong passwords have their own rate limit, checked before scrypt runs, and a header that verified once is remembered so scrypt runs once per session. In production the app refuses to start without `AUTH_USER`/`AUTH_HASH`.
- **Limits**: per-IP token buckets (10 r/s burst 20 for `/api/`, 2 r/s burst 10 for `/api/overland`), 5 MB Overland body limit, server timeouts (headers 10 s, request 30 s, keep-alive 5 s).
- **Tile proxy**: allow-listed styles and integer `z/x/y` only, so it can't be used as an open proxy; only `User-Agent` and `Accept` go upstream, never browser headers.
- **Container**: runs as uid `INGEST_UID` (default 1001) with a read-only root filesystem, all capabilities dropped and `no-new-privileges`. The data dir is writable because ingest appends to it; only the CSV append code writes there, and dates are regex-validated before any file path is built.

---

## 🚀 Quick Start with Docker Compose

Somaari Trip is optimized for **Raspberry Pi 5** (ARM64) and standard x86_64 home servers.

```bash
# 1. Clone or copy files
git clone https://github.com/ashwinkrpi/somaari-trip.git
cd somaari-trip

# 2. Point DATA_DIR at your daily CSVs (default ./data)
echo "DATA_DIR=/path/to/gps-logs" >> .env

# 3. Create login credentials (required — the app won't start without them).
#    Needs Node on the host; prompts for the password, appends AUTH_USER and AUTH_HASH
npm ci
npm run -s hash-password -- <user> >> .env

# 4. Choose who can reach it (default: this machine only). The phone must reach it.
#    0.0.0.0 = every interface (home LAN + ZeroTier/Tailscale); or a single IP for one network
echo "SOMAARI_TRIP_BIND=0.0.0.0" >> .env

# 5. Token for Overland uploads (required)
echo "OVERLAND_TOKEN=$(openssl rand -hex 32)" >> .env
# If DATA_DIR isn't owned by uid 1001, set INGEST_UID / INGEST_GID to its owner

# 6. Start it
docker compose up -d --build
```

Access the web interface at **`http://<server-ip>:<SOMAARI_TRIP_PORT>`** (default port 18473), where `<server-ip>` is `SOMAARI_TRIP_BIND`, or with `0.0.0.0` any of the machine's IPs: its LAN IP on home wifi, its ZeroTier/Tailscale IP from anywhere. In dev mode it's `http://localhost:3000`, which only listens on localhost.

> Docker-published ports bypass `ufw`. Don't port-forward this port to the internet; use ZeroTier/Tailscale/WireGuard for remote access.

> **With `0.0.0.0`**, anyone on your LAN can reach the login page, and on the LAN the password travels as plain HTTP (ZeroTier/Tailscale encrypt their link). Fine on a home network you trust. Give the server a DHCP reservation on the router so its LAN IP doesn't change.

> **Binding to a single VPN IP and reboots** (not an issue with `0.0.0.0`): if `SOMAARI_TRIP_BIND` is a ZeroTier/Tailscale IP, Docker can start before that interface is up. The container then fails with "cannot assign requested address" and Docker doesn't retry, so the app (and Overland uploads) stay down until you run `docker compose up -d`. Overland keeps unsent points and retries, so nothing is lost. Two fixes, both need sudo and a reboot to confirm:
> - **sysctl (simplest):** `echo 'net.ipv4.ip_nonlocal_bind=1' | sudo tee /etc/sysctl.d/99-nonlocal-bind.conf && sudo sysctl --system`. Lets programs listen on an IP before it exists. It doesn't change routing, firewall or what's exposed; the only side effect is that a mistyped bind IP no longer errors.
> - **Docker waits for the IP:** a systemd drop-in for `docker.service` with `After=zerotier-one.service` and an `ExecStartPre` that waits (with a timeout) until the IP is assigned. No kernel setting changes, but every container starts a little later.

---

## 📂 CSV Log Format & Directory Structure

Place daily trip files in `DATA_DIR` (default `./data/`) named `trips_YYYY-MM-DD.csv`.

### Header & Column Specification:
```csv
timestamp,trip_id,lat,lon,speed_mps,speed_accuracy,course,course_accuracy,altitude_m,vertical_accuracy,accuracy_m,battery_level,battery_state,motion,wifi_ssid,device_id,trip_distance_m,trip_mode,trip_start
```

- **`timestamp`**: ISO 8601 UTC (e.g. `2026-08-30T03:30:00.000Z`) — automatically converted to **IST (+05:30)** across the app.
- **`trip_id`**: Identifier grouping points into journeys.
- **`accuracy_m`**: Horizontal GPS accuracy in meters.
- **`speed_mps`**: Speed in meters per second.
- **`motion`**: Activity status (`stationary`, `walking`, `cycling`, `automotive`, `running`).
- **`trip_distance_m`**: Cumulative trip distance in meters.
- **`trip_mode`**: Modality (`walking`, `driving`, `cycling`, `running`, `train`).

---

## 📱 Overland Setup

In Overland's settings:
1. **Receiver Endpoint / Server URL**: `http://<server-ip>:<SOMAARI_TRIP_PORT>/api/overland`. Use the ZeroTier/Tailscale IP so uploads work away from home too.
2. **Access Token**: the `OVERLAND_TOKEN` value from `.env` (sent as `Authorization: Bearer`; `?token=` in the URL also works but ends up in access logs).
3. Tracking: Continuous, accuracy Best. Visits off, pause off.

Plain HTTP is fine over ZeroTier/Tailscale, which encrypt the link. Check it's working with `docker logs somaari-trip` and by looking for today's file in `DATA_DIR`.

---

## 🔌 API Endpoints

- **`GET /api/days`**
  - Scans `./data/` for `trips_YYYY-MM-DD.csv` files.
  - Returns date, point count, total distance, duration, trip counts, and modes.

- **`GET /api/trips?date=YYYY-MM-DD`**
  - Parses that day's CSV and returns GeoJSON LineStrings per `trip_id` and Point stops.
  - Segments are broken wherever the time gap between consecutive points exceeds 5 minutes.

- **`GET /api/trips?from=YYYY-MM-DD&to=YYYY-MM-DD`**
  - Merges multiple daily files for multi-day route visualization.

- **`GET /api/trips?...&max_accuracy=50`**
  - Filters out points where horizontal accuracy exceeds the threshold (default 50m).

- **`POST /api/overland`** (only when `OVERLAND_TOKEN` is set)
  - Overland batch upload. 401 without the token, 400 if `locations` isn't an array, `{"result":"ok"}` once appended.

---

## 🛠️ Features

- **OpenStreetMap & CartoDB Dark Tiles**: Zero external API keys needed. In Docker, the server fetches and caches tiles (`/tiles/`, `tile-cache` volume) so the tile servers never see your browser or which areas you view.
- **Polyline Color Modes**: Color by trip mode or dynamic speed gradient (green → yellow → red).
- **Proximity Clustered Stationary Stops**: Automatically detects 3+ consecutive stationary records with WiFi SSID & battery info.
- **IST Timezone Native**: All timestamps and time spans converted to Indian Standard Time.
- **Small & Memory Bounded**: one ~120 MB image and one process (~60–100 MB RSS), no database; caches are capped so memory doesn't grow with history.

---

## 📄 License

MIT, see [LICENSE](LICENSE).
