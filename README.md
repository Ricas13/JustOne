# JustOne

A deliberately small Jellyfin Live TV bridge built around the DLHD channel catalogue and playback flow, with JustOne's channel merging, naming, logos/artwork and XMLTV guide enrichment kept on top.

The default path remains the known-good DLHD implementation. An optional verified AceStream layer can discover alternative sources for those same canonical channels without allowing public AceStream labels to redefine the lineup.

## Default playback rule

With AceStream disabled (the default), playback is unchanged and intentionally boring:

1. Open the first merged DLHD provider candidate and request its first stream (`source=0`).
2. If FFmpeg cannot produce media, try that candidate's second stream (`source=1`).
3. If the channel had another duplicate provider row merged into it, repeat the same sequence for that row.
4. While playing, actual FFmpeg output bytes are monitored. If no media bytes arrive for the stall timeout, that FFmpeg process is killed and the next ordered source starts in the same HTTP response.
5. If every ordered source fails, the request ends. A new tune starts again from source 1.

There is no DLHD source ranking, warm backup or automatic promotion merely because a source appears better.

## Optional verified AceStream sources

Set `ACESTREAM_ENABLED=true` only when an AceStream Engine search endpoint and MediaFlow Proxy are reachable from `jellyfin-live`.

The important rule is that **DLHD remains the channel catalogue**. AceStream is only a source-discovery pool underneath an already-known JustOne channel.

Discovery is deliberately conservative:

1. JustOne searches AceStream using the canonical DLHD/JustOne channel name.
2. Obvious country or language contradictions are rejected. For example, an `RTP 1` result explicitly identified as Russian is not accepted as RTP 1 Portugal.
3. Matching results are stored as `unverified`; they cannot enter normal playback.
4. You manually verify a known-good hash once. If that result has an AceStream `channel_id`, JustOne records that identity for the canonical channel.
5. Future replacement hashes with the same trusted Ace `channel_id` can inherit verification after they still pass the name/country/language matching gates.
6. A verified Ace source that repeatedly fails playback is temporarily backed off so the remaining ordered sources can be tried.

Automatic verification from metadata alone exists behind `ACESTREAM_AUTO_VERIFY_METADATA=true`, but it is **off by default** because public AceStream names can be wrong.

This first implementation does not perform logo/OCR/frame verification. The trust bootstrap is manual, then persisted `channel_id` identity is used for subsequent replacement hashes.

### AceStream endpoints

When the feature is enabled:

- `GET /jellyfin/acestream` — inspect discovered candidates and their verification state.
- `POST /jellyfin/acestream/discover` — scan the next discovery batch.
- `POST /jellyfin/acestream/discover?all=1` — scan all static channels.
- `POST /jellyfin/acestream/:channelId/:infohash/verify` — mark a candidate as verified and, when available, trust its Ace `channel_id` for that JustOne channel.
- `POST /jellyfin/acestream/:channelId/:infohash/reject` — reject a wrong mapping.

These routes use the same `PLAYLIST_KEY` protection as the other `/jellyfin/*` routes.

`ACESTREAM_PRIORITY=first` tries verified AceStream sources before the existing DLHD candidates. Set it to `fallback` to keep DLHD first and only try verified AceStream after DLHD fails.

AceStream trust state is persisted in the `jellyfin-live-data` Docker volume rather than being rebuilt on every container restart.

## Services

The normal stack still requires only two containers:

- `dlhd-proxy` scrapes the raw channel list, resolves one explicit provider source, and proxies HLS assets with the required referer.
- `jellyfin-live` merges duplicate channels, applies naming/grouping, enriches logos and EPG data, and remuxes chosen sources to MPEG-TS for Jellyfin with sequential failover.

The optional AceStream layer expects existing/reachable services configured by `ACESTREAM_SEARCH_URL` and `ACESTREAM_MEDIAFLOW_URL`; this repository does not force an AceStream Engine or MediaFlow container into the default stack.

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

`JELLYFIN_SOURCES_PER_CANDIDATE` defaults to `2`, matching the intended DLHD stream 1 -> stream 2 behavior. MediaFlow/AceStream candidates are fixed URLs and are attempted once per candidate rather than receiving a DLHD `source=` parameter.

## What was deliberately kept out

The rebuild still does not reintroduce the old `apps/platform` service, warm monitoring, renewable-HLS state machine, rolling playback buffer, image-cache sidecar, or the stack of runtime patches previously applied to dlhd-proxy. The AceStream registry is narrowly scoped to discovery, verification/trust persistence and playback failover.
