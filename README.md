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

A failed or empty catalogue refresh does not replace the last-good in-memory catalogue.

### `easyproxy`

This is the playback engine, built from `domainus/EasyProxy-English` and pinned to an exact commit by default:

```text
8a326aea8d24331182fe0d6012ac15237e780b30
```

EasyProxy handles the actual DLHD extraction and HLS flow. Its other upstream extractors remain part of the engine, but JustOne's current catalogue feeds DLHD candidates only.

The EasyProxy image is deliberately hardened rather than running the upstream tree unchanged:

- Python dependencies are pinned in `docker/easyproxy/requirements.lock` for reproducible builds.
- A deterministic build-time patch removes upstream `os._exit(1)` behaviour. A failed DLHD/Vavoo extraction now returns a request-local HTTP 502 instead of terminating the shared worker and interrupting other viewers.
- The DLHD extraction cache is persisted in `/app/data/.dlhd_cache` through the `easyproxy-data` volume.
- The container health check requires the DLHD extractor module to have loaded, not merely EasyProxy's static `Working` status.
- The image uses one async Gunicorn worker. EasyProxy's DLHD cache is file-backed, so this avoids concurrent workers racing the same cache file while aiohttp still handles concurrent HLS requests asynchronously.

The patch script refuses to build if the pinned upstream source no longer matches the expected code, preventing an upstream change from silently bypassing the safety modifications.

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

`jellyfin-live` only requires EasyProxy to have started, not to be healthy. This keeps the channel list and guide layer available if the playback engine is temporarily down; `/jellyfin/health` reports HTTP 503 while clearly separating `metadataOk` from engine health.

## Playback flow

1. Jellyfin tunes `/jellyfin/play/<stable-channel-id>.m3u8`.
2. JustOne obtains the currently valid ordered candidate URLs for that logical channel.
3. The first candidate is sent to EasyProxy's `/proxy/manifest.m3u8` endpoint.
4. EasyProxy performs extraction/authentication and returns HLS.
5. JustOne rewrites EasyProxy's internal manifest, segment and key URLs to signed `/jellyfin/proxy/...` URLs.
6. Jellyfin follows those URLs; JustOne validates the signature and relays the request to EasyProxy.
7. If EasyProxy cannot produce a valid manifest for the first merged candidate, JustOne tries the next merged candidate in its existing order.

The signed bridge supports master/child manifests, AES-128 keys, `EXT-X-MAP`, alternate media renditions, ordinary media segments, byte-range requests and partial `206` responses.

Candidate ordering remains a metadata concern only. EasyProxy is the only playback engine.

The old `/jellyfin/play/<id>.ts` route remains temporarily as a compatibility alias for clients that cached an old JustOne URL. Newly generated playlists advertise `.m3u8`.

## Security boundary

EasyProxy is a general-purpose proxy, so it is intentionally **not published as a host port and is not routed through Traefik**. The catalogue service is private too.

Only `jellyfin-live` is externally reachable. HLS URLs emitted by EasyProxy are converted into HMAC-signed JustOne bridge URLs before Jellyfin sees them. The bridge refuses targets outside the configured private EasyProxy origin. If `PLAYLIST_KEY` is configured, the existing playlist-key protection is also carried onto those URLs.

Set `EASYPROXY_BRIDGE_SECRET` to a stable random value when `PLAYLIST_KEY` is empty. If neither is configured, JustOne generates an in-memory signing secret on each start, so already-issued segment URLs become invalid after a restart.

The public Express layer uses the simple query parser because JustOne only requires scalar `key` and `refresh` parameters. CI blocks high-severity npm advisories and the direct Express dependency is pinned to the audited 4.22.2 release.

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

## Isolated acceptance test

Before replacing a live JustOne deployment, run the EasyProxy branch in the supplied isolated smoke stack:

```bash
bash scripts/smoke-easyproxy.sh
```

The smoke stack is deliberately separate from production:

- Compose project: `justone-easyproxy-smoke` by default;
- binds only to `127.0.0.1:18090`;
- no Traefik labels;
- no external `media_net` attachment;
- its own EasyProxy cache volume;
- EPG discovery disabled by default to keep the playback acceptance test focused.

The script verifies:

1. all three containers build and start;
2. catalogue and Jellyfin metadata health become ready;
3. the generated playlist advertises `.m3u8`, not the removed `.ts` playback engine;
4. a real candidate can be resolved through EasyProxy;
5. the signed bridge can walk child manifests to actual media bytes;
6. AES keys are retrievable through the signed bridge when present;
7. stopping EasyProxy makes health report 503 while the playlist/metadata layer remains available.

To prefer a known channel during the live-media check:

```bash
SMOKE_CHANNEL_MATCH="BBC One" bash scripts/smoke-easyproxy.sh
```

To leave the isolated stack running after a failure for inspection:

```bash
KEEP_SMOKE=1 bash scripts/smoke-easyproxy.sh
```

Then inspect it with:

```bash
docker compose -p justone-easyproxy-smoke -f docker-compose.smoke.yml ps
docker compose -p justone-easyproxy-smoke -f docker-compose.smoke.yml logs --tail=200
```

The normal smoke run automatically removes its containers, network and smoke volume when it finishes.

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

## CI coverage

PR CI currently checks the engine swap at several levels:

- JavaScript syntax plus the full Jellyfin/EPG/lineup/bridge test suite;
- npm audit with high-severity findings treated as failures;
- catalogue Python compilation, imports and unit tests;
- Compose rendering and assertions that EasyProxy/catalogue are private;
- assertions that the smoke Compose file has no production Traefik/network attachment;
- full builds of all three containers;
- verification that the built EasyProxy image contains the request-local failure patch and persistent-cache patch;
- EasyProxy module import tests;
- a running EasyProxy container test which deliberately sends an invalid DLHD tune, expects HTTP 502, and then verifies the same engine is still alive.

The remaining test that cannot be proven by GitHub CI is successful playback against the provider available from the deployment server. That is the purpose of `scripts/smoke-easyproxy.sh`.

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
