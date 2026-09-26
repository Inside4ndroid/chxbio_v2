# CHXBIO — Torrents Unleashed

A [Stremio](https://www.stremio.com/) addon that scrapes public torrent indexes for movies and
series, with optional debrid support (Real-Debrid, AllDebrid, Premiumize).

It exposes a Stremio stream catalog plus a small web dashboard and a JSON API for
testing scrapers and searching torrents directly.

## Features

- 🔎 Multi-source torrent search across **11 scrapers** (movies + series, French + international)
- 🎬 Stremio `stream`, `catalog` and `meta` handlers (`tt` / `kitsu` / `mal` IDs)
- 📦 Season-pack detection with per-episode file-index resolution
- 🧲 Optional debrid integration (Real-Debrid, AllDebrid, Premiumize)
- 🖥️ Web dashboard with live scraper status, manual search and one-click Stremio install
- ⚙️ Per-scraper testing API, result caching, seeder filtering, configurable timeouts

## Scrapers

| Scraper       | Content              | Notes                                                        |
| ------------- | -------------------- | ------------------------------------------------------------ |
| LimeTorrents  | Movies / Series      |                                                              |
| CPASBien      | French Movies/Series | Via `cpasbien.proxy-site.cc` mirror                          |
| Torrent9      | French Movies/Series | Multi-mirror with failover                                   |
| 1337x         | Movies / Series      | Via `1337xx.to` mirror (main domains are Cloudflare-blocked) |
| TorrentGalaxy | Movies / Series      |                                                              |
| Nyaa.si       | Anime only           | Health check retries with an anime query (`One Piece`)       |
| EZTV          | Movies / Series      | Via `eztvtorrent.me`; publishes **no seed counts** (`0`)     |
| YTS           | Movies               | Results boosted in ranking                                   |
| PirateBay     | Movies / Series      |                                                              |
| ExtTorrents   | Movies / Series      |                                                              |
| RARBG         | Movies / Series      |                                                              |

Retired providers: **BitSearch** (site dead) and **UIndex** (`/search.php` is
Cloudflare-walled for server-side requests) have been removed.

## Requirements

- Node.js **>= 20** (developed/tested on Node 24)
- npm

## Getting started

```powershell
# 1. Install dependencies
npm install

# 2. (Optional) configure environment
Copy-Item .env.example .env

# 3. Run in development mode (auto-restarts on file changes)
npm run dev
```

Then open:

- Dashboard: <http://localhost:7000>
- Stremio manifest: <http://localhost:7000/manifest.json>
- Configure page: <http://localhost:7000/configure>

> First run must be `npm install` — otherwise Node fails with
> `Error: Cannot find module 'express'` because `node_modules/` doesn't exist yet.

## Configuration

All settings are environment variables (see `.env.example`):

| Variable              | Default | Description                                                      |
| --------------------- | ------- | ---------------------------------------------------------------- |
| `PORT`                | `7000`  | HTTP port the server listens on                                  |
| `MIN_SEEDERS`         | `0`     | Hide torrents with fewer seeders                                 |
| `MAX_RESULTS`         | `50`    | Max results per query (`/configure` page exposes this too)       |
| `DISABLED_SCRAPERS`   | _(empty)_ | Comma-separated scraper names/URLs to disable                  |
| `REAL_DEBRID_API_TOKEN` | _(empty)_ | Real-Debrid API token (optional)                               |
| `ALLDEBRID_API_KEY`   | _(empty)_ | AllDebrid API key (optional)                                     |
| `PREMIUMIZE_API_KEY`  | _(empty)_ | Premiumize API key (optional)                                    |
| `SEARCH_TIMEOUT`      | `25000` | Global per-query fan-out window (ms)                             |
| `SCRAPER_TIMEOUT`     | `20000` | Per-scraper timeout inside `searchAll` (ms)                      |
| `TORRENT9_TIMEOUT` / `CPASBIEN_TIMEOUT` / `X1337_TIMEOUT` / `EZTV_TIMEOUT` / `UINDEX_TIMEOUT` | various | Per-scraper overall timeouts (ms) |

Disable a flaky scraper without touching code:

```powershell
$env:DISABLED_SCRAPERS = "eztv,nyaa.si"
npm run dev
```

## Installing in Stremio

1. Start the server and open <http://localhost:7000/configure>.
2. (Optional) paste your debrid tokens and tweak seeder/result limits.
3. Click **Save & Install Addon in Stremio** — this opens the `stremio://<host>/manifest.json?...`
   link (falls back to `https://stremio.com/...`).

For remote hosting, replace `localhost:7000` with your public URL.

## API reference

All endpoints are `GET` and return JSON (except `/` and `/configure`, which return HTML).

| Endpoint | Parameters | Description |
| -------- | ---------- | ----------- |
| `/api/status` | `q` (default `Deadpool 2016`) | Test **all** enabled scrapers, returns per-scraper `working`, `resultsCount`, `elapsed` |
| `/api/test/:scraperName` | `q` (default `Deadpool 2016`) | Test a single scraper (e.g. `/api/test/cpasbien?q=Inception`) |
| `/api/search` | `q` (required), `type` (`movie`\|`series`), `season`, `episode`, `minSeeders`, `maxResults` | Search all scrapers |
| `/api/search/:scraperName` | `q` (required), `type` | Search a single scraper |

Example:

```powershell
Invoke-RestMethod "http://localhost:7000/api/search?q=Inception%202010&type=movie&maxResults=10" |
  Select-Object -ExpandProperty results |
  Select-Object title, seeders, size, source -First 5
```

## npm scripts

| Script  | Command               | Use                              |
| ------- | --------------------- | -------------------------------- |
| `npm run dev` | `node --watch server.js` | Development with live reload (restarts on any required-file change) |
| `npm start`   | `node server.js`         | Production                       |

## Deployment

- **Docker**: a `Dockerfile` is provided (Node 20 Alpine, exposes port `7000`).
  ⚠️ It references `start.js`, which is currently missing from the repo — the Docker
  build will fail until that file is added or the `Dockerfile` is adjusted.
- **Render**: `render.yaml` deploys service `chxbio` (Frankfurt, free plan, `PORT=10000`)
  from <https://github.com/chouxibdev-stack/chxbio_v2> with the env vars above
  (debrid tokens marked `sync: false`).

## Project structure

```
server.js            Express app + Stremio handlers + dashboard/API routes
manifest.js          Stremio addon manifest (id, version, catalogs)
scrapers/
  index.js           Registry, fan-out search, ranking, health checks
  limetorrents.js  cpasbien.js  torrent9.js  x1337.js  torrentgalaxy.js
  nyaa.js  eztv.js  yts.js  piratebay.js  extto.js  rargb.js
debrid/              Real-Debrid / AllDebrid / Premiumize clients + init
utils/
  fetch.js           Shared axios client (cookies, headers, timeouts)
  cache.js           Result/metadata caching + stream cache keys
  parser.js          Torrent-title parsing, season/episode extraction
  packDetector.js    Season-pack detection
  torrentResolver.js .torrent download + episode file-index resolution
  bencode.js         Torrent file decoding
  categories.js      Category maps
```

## How it works

1. Stremio sends a `stream` request with an IMDb/Kitsu/MAL id (`server.js`).
2. The id is resolved to a title (Cinemeta/Kitsu metadata, cached in `utils/cache.js`).
3. `searchAll()` fans out to every enabled scraper in parallel within `SEARCH_TIMEOUT`,
   tags and deduplicates results, then ranks them (French matches first, then YTS,
   then by seeders).
4. Season-pack torrents are matched to the requested episode and resolved to a
   `fileIdx` via `utils/torrentResolver.js` (direct `.torrent` URL first, then
   public caches).
5. Streams (infoHash-based) are returned to Stremio, or direct magnets when no
   debrid service is configured.

## Troubleshooting

| Symptom | Likely cause / fix |
| ------- | ------------------ |
| `Cannot find module 'express'` | Dependencies not installed → run `npm install` |
| Dashboard shows a scraper as `FAILED` | Its site changed domains or added bot protection; check `/api/test/<name>` and the server logs for per-mirror messages |
| EZTV results always show `0` seeds | Expected — the site publishes no seed counts |
| Nyaa.si empty for movies | Expected — Nyaa is anime-only; the health check retries with `One Piece` |
| Port already in use (`EADDRINUSE`) | Another `node server.js` is running (or a previous `npm run dev` didn't exit) — stop it and retry |
| Search is slow | Lower `SCRAPER_TIMEOUT` / `SEARCH_TIMEOUT`, or set `DISABLED_SCRAPERS` for slow providers |
