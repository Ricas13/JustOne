# JustOne

Admin control plane for a **personal** Jellyfin + Stremio stack.

1. Generate thousands of TRaSH-named `.strm` files (1080p and 4K trees).
2. Jellyfin plays a `.strm` → **resolver** asks CinePro for a working source → **HTTP 302** to that URL. Video bytes never pass through JustOne.
3. Live TV M3U from the live backend, IPTVEditor-compatible (`tvg-id`, `tvg-name`, `tvg-logo`, `tvg-chno`, `group-title`, `url-tvg`). Same 302 resolver per channel. Refresh on an interval or on demand.
4. Optional Stremio addon: resolve, then give the player the **direct** URL.

> Personal / educational use only. You are responsible for what backends you connect and for applicable law.

## Libraries (TRaSH / Jellyfin)

```text
data/library/
  movies-1080p/Movie Title (2024) [tmdbid-123]/Movie Title (2024) [tmdbid-123].strm
  movies-4k/Movie Title (2024) [tmdbid-123]/Movie Title (2024) [tmdbid-123].strm
  tv-1080p/Show Name (2022) [tvdbid-456]/Season 01/Show Name (2022) - S01E01 - Episode Title.strm
  tv-4k/...
```

Each `.strm` contains one line:

```text
https://YOUR_HOST/resolve/movie/123?quality=4k
```

## Resolver

| Method | Result |
| --- | --- |
| `GET /resolve/movie/:tmdbId?quality=1080p\|4k` | 302 to a CinePro source |
| `GET /resolve/episode/:tmdbId/:s/:e?quality=` | 302 |
| `GET /resolve/live/:channelId` | 302 (cached; `?refresh=1` forces) |
| `?format=json` | `{ "url": "https://..." }` for Stremio |

## Quick start

```bash
cp .env.example .env   # TMDB_API_KEY, PUBLIC_URL, EPG_URL
docker compose up -d --build
```

Admin UI: `http://YOUR_HOST:8080`

| Endpoint | Use |
| --- | --- |
| `/live/playlist.m3u8` | Jellyfin / IPTVEditor |
| `POST /library/generate` | Bulk STRM from TMDB trending |
| `:7000/manifest.json` | Stremio |

## Jellyfin

Add four libraries pointing at the four folders. For live, add the M3U as a tuner. Point IPTVEditor at the same M3U, map logos/EPG, export back if you want.

## License

See LICENSE. Not affiliated with CinePro, Stremio, Jellyfin, or TRaSH Guides.
