# Architecture

## Services

1. **cinepro** — OMSS backend for movie/series stream resolution (official image).
2. **dlhd** — Live channel list + HLS resolver (dlhd-web).
3. **platform** — JustOne control plane:
   - Health / config
   - Stream proxy (stable URLs for `.strm` and players)
   - STRM library writer + refresh hooks
   - Live M3U export
4. **stremio-addon** — Stremio protocol handlers (catalog / meta / stream).

## Data flow

### VOD → Jellyfin

1. Client asks platform to add a title (TMDB id or search).
2. Platform queries CinePro for sources.
3. Platform selects a source (or user picks one).
4. Platform writes a `.strm` whose URL points at **JustOne proxy** (not the raw third-party URL), e.g. `http://platform:8080/proxy/vod/{jobId}`.
5. Jellyfin scans the library folder and plays via that URL.

### Live TV → Jellyfin / Stremio

1. Platform fetches channel list from dlhd-web.
2. M3U entries point at `http://platform:8080/proxy/live/{channelId}`.
3. Stremio stream handler returns the same proxied URLs.

## Why proxy?

- Inject required referers / headers
- Swap upstream URLs when tokens expire without rewriting every `.strm`
- Central logging and failover across players

## Extending

- Add providers only inside CinePro or dlhd-web upstreams when possible.
- Keep JustOne as the orchestration layer so scrapers can be swapped.
