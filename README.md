# JustOne

A deliberately small Jellyfin Live TV bridge built around the DLHD playback flow, with JustOne's channel merging, naming, logos/artwork and XMLTV guide enrichment kept on top.

The DLHD resolver is a clean implementation informed by the public `amddeus/dlhd-proxy` project and the current DLHD player protocol. The old JustOne playback platform, source scoring, learning, warm standby, rolling buffer and renewable-HLS layers are intentionally not part of this version.

## Playback rule

Playback is intentionally boring:

1. Open the first merged provider candidate and request its first stream (`source=0`).
2. If FFmpeg cannot produce media, try that candidate's second stream (`source=1`).
3. If the channel had another duplicate provider row merged into it, repeat the same sequence for that row.
4. While playing, actual FFmpeg output bytes are monitored. If no media bytes arrive for the stall timeout, that FFmpeg process is killed and the next ordered source starts in the same HTTP response.
5. If every ordered source fails, the request ends. A new tune starts again from source 1.

There is no source ranking, background probing, learning, warm backup or automatic promotion of a source merely because it appears better.

## Services

Only two containers are required:

- `dlhd-proxy` scrapes the raw channel list, resolves one explicit provider source, and proxies HLS assets with the required referer.
- `jellyfin-live` merges duplicate channels, applies naming/grouping, enriches logos and EPG data, and remuxes the chosen source to MPEG-TS for Jellyfin with sequential failover.

## Run

```bash
cp .env.example .env
docker compose up -d --build
```

Default endpoints:

- M3U: `http://localhost:8090/jellyfin/playlist.m3u8`
- XMLTV: `http://localhost:8090/jellyfin/guide.xml`
- Health: `http://localhost:8090/jellyfin/health`
- Diagnostics: `http://localhost:8090/jellyfin/diagnostics`

Set `PUBLIC_URL` to the externally reachable base URL before adding the M3U to Jellyfin. If `PLAYLIST_KEY` is set, the generated playlist and guide URLs include that key.

## Failover tuning

`JELLYFIN_STREAM_STALL_MS` defaults to `12000`. This is the maximum time without FFmpeg output bytes before the current stream is considered stalled.

`JELLYFIN_SOURCES_PER_CANDIDATE` defaults to `2`, matching the intended stream 1 -> stream 2 behavior.

## What was deliberately removed

The rebuild does not include the old `apps/platform` service, candidate manager API, source scoring/learning, warm monitoring, renewable-HLS state machine, rolling playback buffer, image-cache sidecar, Traefik project config, or the stack of runtime patches previously applied to dlhd-proxy.
