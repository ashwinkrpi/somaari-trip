<p align="center">
  <img src="docs/images/banner.svg" alt="somaari-trip" width="100%">
</p>

<p align="center">
  A self-hosted GPS route viewer for Overland on iOS: see where you've been, on a map that only you can open.
</p>

<p align="center">
  <a href="docs/GUIDE.md">Guide</a> | <a href="https://docs.somaari.in/somaari-trip/">Docs</a> | <a href="https://somaari.in/">Website</a> | <a href="https://overland.p3k.app/">Overland</a> | <a href="https://github.com/ashwinkrpi/somaari-trip/issues">Issues</a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/ashwinkrpi/somaari-trip?style=for-the-badge"></a>
</p>


## Introduction

Overland on your iPhone uploads straight to your own server. Routes, stops and stats are drawn from plain daily CSV files: no cloud, no database, no API keys.

> [!WARNING]
> This is your precise location history. Keep the app on your home network or a private network
> (ZeroTier, Tailscale, WireGuard) and **never port-forward it to the internet.**
> See [Who can reach it](docs/GUIDE.md#who-can-reach-it).

## See it work

<p align="center">
  <img src="docs/images/overview.jpg" alt="Day list, trip stats and routes on the map (sample data)" width="90%">
</p>

## How it works

<img src="docs/images/architecture.svg" alt="Overland iOS posts points to Ingest, which appends rows to daily CSV files; the Parser feeds the API. The browser goes through Express to the API and to a tile proxy that fetches from OpenStreetMap on a cache miss." width="640">

<details>
<summary><b>Step by step</b></summary>

<br>

Everything runs in **one container, one Node process** (Express; no nginx, no database),
published on `SOMAARI_TRIP_BIND:SOMAARI_TRIP_PORT` (default `127.0.0.1:18473`).

1. **Phone (Overland iOS)** logs GPS points in the background and POSTs them in batches (JSON
   `locations` array) to `/api/overland`, with a bearer token, over your LAN or a private network.
2. **Ingest** (only when `OVERLAND_TOKEN` is set; token instead of the login, 5 MB body limit,
   own rate limit) buckets each point by its **IST** date and appends rows to
   `trips_YYYY-MM-DD.csv`, writing the header for a new file. It replies only after the rows are
   on disk; on failure it returns 500 so Overland keeps the batch and retries.
3. **Storage** is plain CSV files on disk, one per IST day: no database.
4. **API**:
   - Parses CSVs, drops bad rows and points with accuracy worse than 50 m (adjustable), and
     treats `speed=-1` as unknown rather than stopped. Day summaries are cached per file until it
     changes, and parsed points sit in a capped LRU (~100k points), so memory doesn't grow with
     history.
   - Groups points by `trip_id`, splits trips on gaps over 5 minutes, ends a trip at its last
     movement when it then sits still for over 10 minutes, and computes distance
     (from Overland's `trip_distance_m`, or point to point when that's missing), duration and
     speeds. Stops are 3+ consecutive stationary points of one trip with no gap over 15 minutes;
     a point is stationary when `motion` says so, or its speed is 0 with accuracy within 30 m.
   - Days are **IST days**, and files are named by IST date, so day D is read from file D alone.
     A trip crossing midnight is split between both days.
5. **Web**: the login screen and session cookie guard `/api/` and `/tiles/` (all but
   `/api/overland`, `/api/health` and the login itself); serves the built React app (precompressed `.br`/`.gz`, hashed assets cached `immutable`); proxies `/tiles/osm/` to
   OpenStreetMap with a disk cache (`tile-cache` volume, 1 GB cap); security headers, a strict CSP and
   per-IP rate limits.
6. **Browser** (React + Leaflet) loads the day list, then that day's trips and stops, and draws
   them in IST. It only ever talks to your server.

</details>

## Features

- 📱 **Straight from Overland**: the iPhone app posts batches to your server with a token. Points
  are written to disk before Overland is told "ok", so nothing is lost if anything fails.
- 🗺️ **Trips and stops**: routes split into trips, gaps over 5 minutes shown as separate
  segments, stops detected where you stayed put, with WiFi network and battery level.
- 🎨 **Colour by mode or speed**: walking, cycling, driving and more, or a green → red speed
  gradient. Grey where the phone didn't report a speed.
- 📅 **Days and ranges**: one day, a custom range, the last 3 or 7 days with data, or all of them,
  with totals for distance, time, speed, trips and stops.
- 🎯 **Accuracy filter**: hide jittery GPS points with a slider (10 to 100 m).
- 🕰️ **IST throughout**: days run midnight to midnight IST, and every time is shown in IST.
- 🔒 **Private map tiles**: the server fetches and caches OpenStreetMap tiles, so the tile
  server never sees your browser.
- 📲 **Works on a phone**: the sidebar folds away into a menu.
- 🪶 **Light on the Pi**: one container and one Node process, ~60–100 MB of RAM, a ~120 MB image,
  and memory that doesn't grow with years of history.

> [!NOTE]
> No accounts, no API keys, no third-party services. The only things outside your network are
> the map tile servers, and only your server talks to them.

## Install

You need a Linux machine that stays on (Raspberry Pi 5 or any x86_64 server), Docker with the
Compose plugin, and Overland on your iPhone. The [guide](docs/GUIDE.md) covers the rest:
- [Install with Docker](docs/GUIDE.md#install-with-docker) and
  [who can reach it](docs/GUIDE.md#who-can-reach-it) (LAN, ZeroTier/Tailscale, reboots)
- [Settings](docs/GUIDE.md#settings): every `.env` option and its default
- [Login](docs/GUIDE.md#login): creating and changing the password, or turning the login off
- [Overland (iPhone)](docs/GUIDE.md#overland-iphone): app settings and checking uploads arrive
- [Data files](docs/GUIDE.md#data-files): CSV format, ownership, backups
- [Updating](docs/GUIDE.md#updating) and [trying it with sample data](docs/GUIDE.md#try-it-with-sample-data)

## Usage

| Do this… | What happens |
|---|---|
| Click a day in **Dates** | Its routes, stops and totals load, and the map zooms to fit |
| **Date Range** → **Past 7 Days** | Every trip in the range on one map, with combined totals |
| Click a trip in **Trips** | It's highlighted and zoomed to; the stats bar shows its mode |
| Click a purple stop | How long you stayed, when, the WiFi network and battery level |
| **Display** → **By Speed** | Routes coloured green → red by speed, with a legend |
| **Display** → **Filter By Mode** | Only walking, only driving, … everywhere on the page |
| **↻** next to the title | Loads points uploaded since you opened the page |

Everything else, with screenshots: [Using the app](docs/GUIDE.md#-using-the-app).

## Privacy

> [!IMPORTANT]
> **TL;DR:** your location history stays on your server, in files you own. The phone uploads
> only to your server, the browser only talks to your server (enforced by the CSP), and there's
> no analytics or telemetry. Map tiles are the one outside request, made by the server.

<details>
<summary><b>What leaves your server, and what doesn't</b></summary>

<br>

- **Overland** sends points only to the URL you configure: your server.
- **The browser** loads the app, the API and map tiles from your server only. The production CSP
  allows `'self'` and nothing else, so no fonts, scripts or trackers load from elsewhere.
- **Map tiles**: on a cache miss, the server fetches the tile from OpenStreetMap with only
  `User-Agent` and `Accept` headers. OpenStreetMap sees your server's IP and which map tiles
  were requested (which reveals the areas viewed), never your browser, cookies or location
  points. Cached tiles are reused for 30 days.
- **Not stored anywhere else:** no database, no copies. Back up `./data` to back up your
  history, and encrypt it at rest (gocryptfs, LUKS) if the machine could be physically accessed.
- **Dev mode** (`npm run dev`) has no login by default and fetches tiles from the browser directly,
  so it uses its own `./data-dev` folder and never reads `./data`.

</details>

## Security model

| Layer | Protection |
|---|---|
| **Login** | Its own login screen and a signed session cookie on every route that reads data. One user, scrypt hash in `auth.json`, reset with `setpassword` on the server. `NO_LOGIN=true` turns it off on purpose |
| **Overland** | Its own bearer token, compared in constant time, 5 MB body limit |
| **Limits** | Per-IP rate limits and server timeouts; 5 wrong passwords in 15 minutes block an address for 15 minutes |
| **Container** | Non-root user, read-only root filesystem, all capabilities dropped, `no-new-privileges` |

<details>
<summary><b>Details</b></summary>

<br>

There's no reverse proxy in front: Express does the login, limits and headers itself.
- **Login**: `POST /api/login` checks the user name and scrypt password (scrypt runs for a wrong
  user too, and the compare is constant-time) and sets an HMAC-signed `HttpOnly`,
  `SameSite=Strict` cookie: 30 days with **Keep me logged in**, otherwise a browser session that
  ends after a day unused. No sessions are stored; `setpassword` and `logout-all` rotate the
  signing secret in `auth.json`, which ends them all, and the server notices the file change on
  its next request. A missing or broken `auth.json` locks everything (fail closed). Login and
  logout only accept JSON from the app's own origin. 5 wrong passwords from one address in 15
  minutes block it for 15 minutes, checked before scrypt runs, and each wrong one waits a
  second. The page and its scripts load without a login (they hold no data) so the login screen
  can show; a 401 never sends `WWW-Authenticate`, so the browser shows no popup.
- **Limits**: per-IP token buckets (10 r/s burst 20 for `/api/`, 2 r/s burst 10 for
  `/api/overland`), 5 MB Overland body limit, server timeouts (headers 10 s, request 30 s,
  keep-alive 5 s).
- **Headers**: strict CSP (`'self'` only), `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, `Permissions-Policy`; no `X-Powered-By`.
- **Tile proxy**: allow-listed styles and integer `z/x/y` only, so it can't be used as an open
  proxy; only `User-Agent` and `Accept` go upstream, never browser headers.
- **Container**: runs as uid `INGEST_UID` (default 1001). The data dir is writable because ingest
  appends to it; only the CSV append code writes there, and dates are regex-validated before any
  file path is built.
- **Network**: plain HTTP, meant for a LAN or an encrypted private network; see
  [Who can reach it](docs/GUIDE.md#who-can-reach-it).

</details>

## API

| Endpoint | Returns |
|---|---|
| `GET /api/days` | Every day with data: date, points, distance, duration, trips, modes, stops |
| `GET /api/trips?date=YYYY-MM-DD` | That day's trips (GeoJSON lines, split at gaps over 5 min), stops and a summary. With no date, the latest day |
| `GET /api/trips?from=…&to=…` | The same for a range of days (either end may be left out) |
| `…&max_accuracy=50` | Drops points less accurate than this many metres (default 50) |
| `GET /api/session` | `{"loginRequired", "authenticated", "user"}`, no login needed |
| `POST /api/login` | JSON `{"user", "password", "remember"}`; sets the session cookie. 401 wrong, 429 blocked |
| `POST /api/logout` | Clears the session cookie |
| `GET /api/health` | `{"status":"ok", …}`, no login needed |
| `POST /api/overland` | Overland batch upload (bearer token, not the login). 401 bad token, 400 no `locations` array, `{"result":"ok"}` once on disk, 500 if the write failed |
| `POST /api/seed` | Rewrites the sample days. Only exists when `SEED_SAMPLE_DATA=true` (dev) |

All but `/api/health`, `/api/overland` and the session endpoints need the login (401 without it). Dates that aren't `YYYY-MM-DD` get a
400, too many requests a 429 with `Retry-After`. CSV columns:
[Data files](docs/GUIDE.md#data-files).

## Development

```sh
npm ci
SEED_SAMPLE_DATA=true npm run dev   # API + Vite on 127.0.0.1:3000, sample data in ./data-dev, no login
npm run setpassword                 # turn the login on in dev (writes ./data-dev/auth.json; restart dev)
npm run lint                        # tsc --noEmit
npm test                            # vitest
npm run build                       # frontend + bundled server into dist/
npm run screenshots                 # rebuild, retake docs/images/*.jpg from sample data
node scripts/sample-routes.mjs      # refetch the sample trips' road geometry (OSM routing, rarely needed)
```

The dev server reads `./data-dev` and fetches map tiles directly; production reads `./data`, serves
`dist/` and proxies tiles. Dev has a login only once `./data-dev/auth.json` exists. Built with
TypeScript, Express, React, Leaflet, Tailwind CSS and PapaParse. Screenshots in `docs/images/`
are taken from sample data only, never real location history: `npm run screenshots` runs the
production build on generated sample data in a temp dir with a throwaway login, and drives
headless Chromium (`CHROMIUM=/path` to override).

## Contributing

This is a personal project and doesn't accept pull requests. You're welcome to fork it and adapt
it for yourself, and bug reports in [Issues](https://github.com/ashwinkrpi/somaari-trip/issues)
are appreciated.

## License

MIT, see [LICENSE](LICENSE).
