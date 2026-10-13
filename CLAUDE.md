# Somaari Trip

Self-hosted GPS route viewer. Overland iOS → `POST /api/overland` → daily CSVs → Express API → React/Leaflet map. Runs on a Raspberry Pi 5. No DB, no API keys. One container, one Node process (Express does auth, static files, tile cache; no nginx). Basic auth from `AUTH_USER`/`AUTH_HASH`; port bound via `SOMAARI_TRIP_BIND`. Data is the owner's precise location history, so treat it as sensitive.

## Layout
- `server.ts`: env → `createApp`, Vite middleware in dev, server timeouts. Prod exits without `AUTH_USER`/`AUTH_HASH` (`npm run hash-password`)
- `server/app.ts`: `createApp` with routes `/api/health`, `/api/days`, `/api/trips`, `/api/overland` (only if `OVERLAND_TOKEN` is set), `/api/seed` (only if `SEED_SAMPLE_DATA=true`), `/tiles/` (prod), security headers, rate limits, basic auth (all but health/overland), static `dist/`
- `server/auth.ts` (scrypt basic auth), `server/rateLimit.ts` (per-IP token buckets), `server/staticFiles.ts` (precompressed `.br`/`.gz` from the Vite build, gzipped JSON), `server/tileProxy.ts` (allow-listed CARTO/OSM tile proxy with disk cache under `cache/tiles`, prod only)
- `server/overlandIngest.ts`: Overland payload → IST-dated CSV rows (pure), and the per-file append queue
- `server/tripParser.ts`: CSV parse, stop detection, trip/segment building, day summaries (pure functions)
- `server/seedData.ts`: sample CSV generator (only when `SEED_SAMPLE_DATA=true`)
- `src/App.tsx`: state and fetching. `src/components/{Sidebar,MapViewer,TripStatsBar}.tsx`
- `shared/types.ts`: API types used by both server and client; `shared/format.ts`: `formatDuration`
- `server/*.test.ts`: vitest tests (`app.test.ts` runs the app on a random port)
- `src/utils/time.ts`: IST formatting, mode/speed colors
- `docs/GUIDE.md` + `docs/images/`: installation, configuration (settings, login, Overland, CSV format) and user guide; README keeps overview, architecture, security, API, development; screenshots taken from a `SEED_SAMPLE_DATA=true` server only. Update both when the UI changes
- Docker: one `Dockerfile` (build stage bundles server + deps into `dist/server.cjs`; runtime is `alpine` + stripped Node binary, no `node_modules`). `docker-compose.yml` has one service `somaari-trip` as uid `INGEST_UID` (default 1001), host `SOMAARI_TRIP_BIND:SOMAARI_TRIP_PORT` (default 127.0.0.1:18473) → :3000, `DATA_DIR` rw, `tile-cache` volume, read-only root fs, no healthcheck

## Commands
- `npm run dev`: tsx server.ts (API + Vite on :3000)
- `npm run lint`: `tsc --noEmit` (with `noUnusedLocals`)
- `npm test`: vitest
- `npm run build`: vite build (with `.br`/`.gz`) + esbuild server → `dist/`
- `npm run -s hash-password -- <user> >> .env`: append `AUTH_USER`/`AUTH_HASH`
- `docker compose up -d --build`

## Data
- Files: `data/trips_YYYY-MM-DD.csv` (dev) or the host dir in `DATA_DIR` (`.env`) mounted rw (prod)
- Timestamps are UTC ISO; the UI shows IST. API days are IST days. Files are named by **IST** date (all existing files checked); `loadPointsForIstRange` reads only files in the range and still filters per point.
- Columns: see `docs/GUIDE.md` (Data files). Overland reports `speed=-1` when speed is unknown.

## Conventions
- TypeScript, 2-space indent, single quotes, Tailwind classes inline, lucide-react icons
- Leaflet is used imperatively through refs (not react-leaflet components)
- Escape any CSV-derived string before putting it in Leaflet HTML
- Validate dates as `^\d{4}-\d{2}-\d{2}$` before building file paths
- The repo is meant to be public: test fixtures, screenshots and docs use synthetic data only (never a real CSV row, Overland payload or coordinate), and host-specific details (IPs, paths) stay in `.env` or `plans/`

## Work in progress
Plans live in `plans/` (gitignored, local only; absent in a fresh clone). The repo is public (`origin`, history squashed); full private history is in remote `private`, never push `main` there. `INGEST_PLAN.md` is done except the phone cutover; `IMPROVEMENT_PLAN.md` and `REDESIGN_PLAN.md` are done except optional items. Work stage by stage, tick items off. Read only the files an item names.
