# JustOne Catalog

JustOne is an **IPTV catalogue/control plane**. It does not proxy, remux, transcode, probe or play video. There is no FFmpeg playback path in JustOne.

## What decides which channels exist?

**DLHD is the authoritative availability catalogue.** JustOne periodically reads:

- DLHD's 24/7 channel catalogue
- DLHD's current schedule/events

It then filters every configured IPTV provider/account playlist against that reference. A channel that exists in an IPTV list but is not represented by DLHD is not emitted.

DLHD is used only for **names, availability, event relationships and optional logos**. Playback always comes from your own configured IPTV playlists.

If `DLHD_API_KEY` is set, JustOne prefers DLHD's structured `channels` and `schedule` JSON API. Without a key it uses the public 24/7 and schedule HTML pages.

## Architecture

```text
DLHD 24/7 + schedule ───────────────┐
                                     │ authoritative whitelist
Provider A / Line 1 M3U ────────────┤
Provider A / Line 2 M3U ────────────┤
Provider B / Line 1 M3U ────────────┤
                                     ▼
                              JustOne Catalog
                           match / filter / enrich
                                     │
                    Docker-internal M3Us + XMLTV
                                     │
                                     ▼
                         connection-management layer
                                     │
                                     ▼
                                Dispatcharr
                                     │
                                     ▼
                                  Jellyfin
```

For schedule events, JustOne first looks for an IPTV entry matching the event title. It can also use the **specific linear channels DLHD lists for that event** (for example Sky Sports Football). Generic DLHD labels such as `Event Stream`, `Event SD Stream` and `Channel Not Listed` are deliberately not used as cross-event aliases because they are ambiguous.

## Source/variant ordering

Within one canonical channel/event, JustOne keeps all useful provider variants and orders them breadth-first across failure domains before going deeper into one provider/account:

```text
Provider A / account 1 / HD
Provider B / account 1 / HD
Provider A / account 2 / HD
Provider A / account 1 / backup HD
Provider B / account 1 / backup HD
...
```

Dispatcharr remains responsible for real-time connection capacity, buffering detection and failover.

## Internal-only M3U/XMLTV

M3U and XMLTV outputs are served on a **separate internal listener** (`8091`). `docker-compose.yml` uses `expose`, not `ports`, so that listener has no host/public port.

The admin/API listener is separate (`8090`) and is published to `127.0.0.1` only by default.

Internal output URLs are typically:

```text
http://justone-catalog:8091/m3u/source/<source-id>.m3u
http://justone-catalog:8091/m3u/master.m3u
http://justone-catalog:8091/epg/guide.xml
```

`GET /api/internal-outputs` returns the exact generated internal URLs for your configured sources.

To let another Docker container consume them, attach that container to the same network:

```bash
docker network connect justone-internal <consumer-container>
```

Do **not** publish port `8091` through Docker, Traefik, Cloudflare or another reverse proxy.

## Failure behaviour

`DLHD_FAIL_CLOSED=true` is the default. That means:

- a DLHD refresh failure never causes JustOne to expose the entire unfiltered provider list;
- the last-known-good DLHD reference is reused when possible;
- if there is no valid DLHD reference at all, the refresh fails instead of publishing unwanted output.

Provider and XMLTV refresh failures also retain last-known-good data where possible.

## Quick start

```bash
cp .env.example .env
# set ADMIN_KEY
docker compose up -d --build
```

Open `http://127.0.0.1:8090/admin` locally. The service creates `/data/state.json` on first start.

Add one source per real provider credential/line:

```bash
curl -X POST http://127.0.0.1:8090/api/sources \
  -H 'Authorization: Bearer change-me' \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"Provider A - Line 1",
    "provider":"Provider A",
    "account":"Line 1",
    "maxStreams":1,
    "priority":10,
    "url":"https://provider.example/line1.m3u",
    "enabled":true
  }'
```

Add XMLTV sources in the same way via `/api/guides`, then run:

```bash
curl -X POST http://127.0.0.1:8090/api/refresh \
  -H 'Authorization: Bearer change-me'
```

Inspect DLHD matching:

```bash
curl http://127.0.0.1:8090/api/dlhd \
  -H 'Authorization: Bearer change-me'
```

The response includes matched-reference counts and up to 200 currently unmatched DLHD channels/events, which is useful for improving aliases without broadening matching unsafely.

## Dispatcharr safety

JustOne only owns Dispatcharr channels whose `tvg_id` starts with `justone.`. Reconciliation is preview-only unless both of these are true:

```text
DISPATCHARR_APPLY_ENABLED=true
```

and the reconcile request explicitly contains:

```json
{"apply": true}
```

Use `/api/dispatcharr/preview` before applying.

## Metadata / EPG

Static channels use configured XMLTV data where it can be matched by original `tvg-id` or channel name. Event channels get a generated XMLTV programme from the DLHD schedule, while logos may still be enriched from the matched underlying IPTV/EPG channel.

Logo precedence remains:

```text
manual override → matched XMLTV logo → DLHD/provider logo
```

## Important APIs

Admin/API listener (`8090`):

- `GET /api/catalog`
- `GET /api/dlhd`
- `GET /api/internal-outputs`
- `GET/POST /api/sources`
- `GET/POST /api/guides`
- `PUT /api/aliases`
- `PUT /api/overrides`
- `POST /api/refresh`
- `GET /api/dispatcharr/preview`
- `POST /api/dispatcharr/reconcile`

Internal listener (`8091`, Docker network only):

- `GET /m3u/source/:sourceId.m3u`
- `GET /m3u/master.m3u`
- `GET /epg/guide.xml`

## Still deliberately absent

JustOne still contains no DLHD playback resolver, video proxy, FFmpeg remuxing, playback state machine, warm standby or stream-health probing. DLHD determines **what should exist**; your IPTV providers and Dispatcharr determine **how it plays**.
