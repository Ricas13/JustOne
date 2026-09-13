# JustOne

JustOne is now a Jellyfin Live TV **metadata layer around EasyProxy**.

The parts that make the channel list useful in Jellyfin stay in JustOne: channel merging, stable IDs, numbering/grouping, logos/artwork and XMLTV/EPG enrichment. The old JustOne media engine has been removed. EasyProxy owns stream extraction, authentication, manifest rewriting, keys and media proxying.

## Architecture

```text
DLHD catalogue page
        |
        v
  dlhd-catalogue          catalogue only: id + name + provider page URL
        |
        v
  jellyfin-live           channel merge / names / groups / icons / EPG
        |
        | tune one stable Jellyfin channel
        v
    EasyProxy             all playback extraction and HLS proxying
        |
        v
 signed /jellyfin/proxy bridge
        |
        v
      Jellyfin
```

### `dlhd-catalogue`

This service only discovers raw channel IDs and names from the provider catalogue. It does **not** resolve streams, proxy HLS, fetch keys or serve media.

Its M3U contains provider page URLs such as `watch.php?id=...`. Those URLs are metadata-layer candidates which are handed to EasyProxy only when a channel is tuned.

### `easyproxy`

This is the playback engine, built from `domainus/EasyProxy-English` and pinned to an exact commit by default:

```text
8a326aea8d24331182fe0d6012ac15237e780b30
```

EasyProxy handles the actual DLHD extraction and HLS flow. Its other upstream extractors remain part of the engine, but JustOne's current catalogue feeds DLHD candidates only.

The image uses one async Gunicorn worker by default. EasyProxy's DLHD cache is file-backed and process-local, so one worker avoids concurrent workers racing the same cache file. aiohttp still handles concurrent HLS requests asynchronously.

### `jellyfin-live`

This remains the stable Jellyfin-facing layer. It owns:

- canonical channel IDs;
- duplicate-channel merging;
- channel ordering and groups;
- channel and programme artwork;
- IPTV-org identity enrichment;
- XMLTV/EPG generation;
- stable Jellyfin M3U URLs;
- a signed bridge to the private EasyProxy service.

It no longer contains FFmpeg and no longer remuxes media.

## Playback flow

1. Jellyfin tunes `/jellyfin/play/<stable-channel-id>.m3u8`.
2. JustOne obtains the currently valid ordered candidate URLs for that logical channel.
3. The first candidate is sent to EasyProxy's `/proxy/manifest.m3u8` endpoint.
4. EasyProxy performs extraction/authentication and returns HLS.
5. JustOne rewrites EasyProxy's internal manifest, segment and key URLs to signed `/jellyfin/proxy/...` URLs.
6. Jellyfin follows those URLs; JustOne validates the signature and relays the request to EasyProxy.
7. If EasyProxy cannot produce a valid manifest for the first merged candidate, JustOne tries the next merged candidate in its existing order.

Candidate ordering remains a metadata concern only. EasyProxy is the only playback engine.

The old `/jellyfin/play/<id>.ts` route remains temporarily as a compatibility alias for clients that cached an old JustOne URL. Newly generated playlists advertise `.m3u8`.

## Security boundary

EasyProxy is a general-purpose proxy, so it is intentionally **not published as a host port and is not routed through Traefik**. The catalogue service is private too.

Only `jellyfin-live` is externally reachable. HLS URLs emitted by EasyProxy are converted into HMAC-signed JustOne bridge URLs before Jellyfin sees them. If `PLAYLIST_KEY` is configured, the existing playlist-key protection is also carried onto those URLs.

Set `EASYPROXY_BRIDGE_SECRET` to a stable random value when `PLAYLIST_KEY` is empty. If neither is configured, JustOne generates an in-memory signing secret on each start, so already-issued segment URLs become invalid after a restart.

## Run

```bash
cp .env.example .env
# Edit PUBLIC_URL and any proxy settings you need.
docker compose up -d --build --remove-orphans
```

Default Jellyfin-facing endpoints:

- M3U: `http://localhost:8090/jellyfin/playlist.m3u8`
- XMLTV: `http://localhost:8090/jellyfin/guide.xml`
- Health: `http://localhost:8090/jellyfin/health`
- Diagnostics: `http://localhost:8090/jellyfin/diagnostics`

`easyproxy` and `dlhd-catalogue` are reachable only over the Compose network.

For an existing pre-EasyProxy JustOne deployment, use `--remove-orphans` during the first deployment so the old `dlhd-proxy` container is removed.

## Configuration

Core settings:

- `PUBLIC_URL` — externally reachable JustOne base URL.
- `PLAYLIST_KEY` — optional existing protection for `/jellyfin` resources.
- `EASYPROXY_BRIDGE_SECRET` — stable HMAC secret for internal EasyProxy bridge URLs.
- `EASYPROXY_REQUEST_TIMEOUT_MS` — maximum time to obtain an initial manifest from one EasyProxy candidate; default `60000`.
- `EASYPROXY_REPO` — EasyProxy Git repository used at image build time.
- `EASYPROXY_REF` — exact EasyProxy commit/tag to build; pinned by default.
- `DLHD_BASE_URL` — source used only to discover the raw channel catalogue.
- `DLHD_EASYPROXY_BASE_URL` — provider host used when constructing the channel page URL that EasyProxy receives.
- `CHANNEL_REFRESH_SECONDS` — raw channel catalogue refresh interval.

Proxy settings exposed by EasyProxy:

- `GLOBAL_PROXY`
- `VAVOO_PROXY`
- `DLHD_PROXY`

`SOCKS5` remains separate and applies only to catalogue discovery.

## What is deliberately gone

The old JustOne playback implementation is not part of this architecture:

- no FFmpeg remux process in `jellyfin-live`;
- no JustOne HLS resolver;
- no JustOne AES/key proxy;
- no JustOne stream-source probing engine;
- no source learning/scoring;
- no warm standby;
- no rolling buffer.

The channel organisation, artwork and EPG code remains the JustOne layer above EasyProxy.
