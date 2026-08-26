# JustOne

**One personal media hub** for movies, series, and live TV — with Stremio addons and Jellyfin-ready `.strm` libraries.

> **Personal / educational use only.** JustOne does not host or store video files. It resolves third-party stream URLs and writes lightweight pointer files (`.strm`) or playlist endpoints. You are responsible for complying with applicable laws and provider terms.

## What it does

| Feature | Description |
|--------|-------------|
| **VOD** | Talks to [CinePro Core](https://github.com/cinepro-org/core) (OMSS) for movie/series sources |
| **Live TV** | Talks to [dlhd-web](https://github.com/Lunatic16/dlhd-web) for DaddyLive/DLHD-style channels |
| **Stremio** | Unified addon catalogs for movies, series, and live TV |
| **Jellyfin** | Writes `.strm` files (and optional M3U) so Jellyfin can scan and play remote streams |
| **Docker** | One `docker compose up` for the control plane + backends |

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     JustOne Platform                     │
│  (API · STRM writer · proxy · Stremio addon · web UI)    │
└────────────┬─────────────────────────────┬───────────────┘
             │                             │
     ┌───────▼───────┐             ┌───────▼───────┐
     │  CinePro Core │             │   dlhd-web    │
     │  (movies/TV)  │             │  (live TV)    │
     └───────────────┘             └───────────────┘
             │                             │
             ▼                             ▼
        Stremio / Jellyfin (.strm + M3U)
```

## Quick start

### Prerequisites

- Docker + Docker Compose
- Free [TMDB API key](https://www.themoviedb.org/settings/api)

### 1. Configure

```bash
cp .env.example .env
# Edit .env — set at least TMDB_API_KEY
```

### 2. Run

```bash
docker compose up -d
```

Services (defaults):

| Service | URL |
|---------|-----|
| JustOne API / UI | http://localhost:8080 |
| Stremio manifest | http://localhost:8080/stremio/manifest.json |
| CinePro Core | http://localhost:3000 |
| dlhd-web | http://localhost:3001 |
| Live M3U | http://localhost:8080/live/playlist.m3u8 |

### 3. Stremio

Install addon URL:

```text
http://YOUR_HOST:8080/stremio/manifest.json
```

(Use a reachable host/HTTPS if not on the same machine.)

### 4. Jellyfin `.strm` library

1. In `.env`, set library paths (or use the defaults under `./data/library`).
2. Use the API or UI to resolve a title → JustOne writes:
   - `data/library/movies/Title (Year)/Title (Year).strm`
   - `data/library/tv/Show Name/Season XX/Show Name - SxxExx.strm`
3. In Jellyfin, add those folders as **Movies** / **Shows** libraries.
4. Optionally enable the refresh job to re-resolve dead streams.

Point Jellyfin Live TV at:

```text
http://YOUR_HOST:8080/live/playlist.m3u8
```

## Project layout

```text
JustOne/
├── docker-compose.yml
├── .env.example
├── apps/
│   ├── platform/          # Control API, STRM manager, proxy, config
│   └── stremio-addon/     # Stremio manifest + catalog/stream handlers
├── data/
│   └── library/           # .strm output (gitignored content)
├── docs/
│   ├── architecture.md
│   └── jellyfin.md
└── README.md
```

CinePro and dlhd-web run as **external images/services** in Compose (not vendored). This keeps updates simple when upstream scrapers change.

## Status

**Scaffold / early development.** Core wiring, STRM writer, and Stremio handlers are being built out. Scrapers depend on third-party sites and may break without warning.

## License & disclaimer

See [LICENSE](LICENSE). Not affiliated with CinePro, DaddyLive/DLHD, Stremio, or Jellyfin.
