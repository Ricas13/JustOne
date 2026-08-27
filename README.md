# JustOne

**One personal media hub** for movies, series, and live TV — with a web UI, a unified Stremio addon, and Jellyfin-ready `.strm` files.

> **Personal / educational use only.** JustOne does not host or store video files. It talks to resolvers you run, writes pointer files (`.strm`), and exposes playlist / addon endpoints. You are responsible for complying with applicable laws and provider terms.

## What you get

| Piece | What it is |
| --- | --- |
| **Web UI** | Browse movies, series, live channels, play, write STRM |
| **CinePro** | Optional VOD resolver (official image) |
| **dlhd-web** | Optional live-TV resolver |
| **Stremio** | One addon: movies + series + live TV |
| **Jellyfin** | `.strm` library + live M3U |
| **Docker** | `docker compose up -d` |

## Quick start

1. Copy env and set a [TMDB API key](https://www.themoviedb.org/settings/api):

```bash
cp .env.example .env
```

2. Start:

```bash
docker compose up -d --build
```

3. Open the hub at `http://localhost:8080`

| Service | URL |
| --- | --- |
| Hub UI | http://localhost:8080 |
| Health | http://localhost:8080/health |
| Stremio (unified) | http://localhost:7000/manifest.json |
| CinePro native Stremio | http://localhost:3000/stremio/manifest.json |
| Live M3U | http://localhost:8080/live/playlist.m3u8 |

## Stremio

Add this addon URL in Stremio:

```text
http://YOUR_HOST:7000/manifest.json
```

That one addon catalogs movies, series, and live TV. You can still also install CinePro’s own `/stremio/manifest.json` if you prefer.

## Jellyfin STRM

1. In the UI, open a title → **Write STRM**.
2. Files land in `data/library/movies` and `data/library/tv`.
3. Add those folders as Jellyfin libraries.
4. For live TV, add `http://YOUR_HOST:8080/live/playlist.m3u8` as an M3U tuner.

## Layout

```text
JustOne/
├── docker-compose.yml
├── apps/platform/          # UI + API + STRM + proxies
├── apps/stremio-addon/     # unified Stremio addon
├── docker/dlhd/            # builds upstream dlhd-web
└── data/library/           # .strm output
```

CinePro and dlhd-web are **not vendored**. They run as Compose services so you can update them independently.

## License

See [LICENSE](LICENSE). Not affiliated with CinePro, DaddyLive/DLHD, Stremio, or Jellyfin.
