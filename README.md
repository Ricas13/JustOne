# JustOne Catalog

JustOne is an **IPTV catalogue/control plane**. It does not proxy, remux, transcode or play video. There is no FFmpeg playback path in JustOne.

## Desired lineup

DLHD is the authoritative reference for what should exist.

The output policy is intentionally narrow:

- **all current/upcoming DLHD events**
- **UK static / 24-7 channels only**
- **Portugal static / 24-7 channels only**
- **USA static / 24-7 channels only**
- everything else from provider playlists is discarded

The country policy is controlled by:

```text
DLHD_STATIC_COUNTRIES=GB,PT,US
```

Events are not country-filtered: if DLHD lists the event, JustOne tries to find it in the configured IPTV playlists.

DLHD is used only for **names, availability, event relationships and optional logos**. Actual playback always comes from your configured IPTV providers.

If `DLHD_API_KEY` is configured, JustOne prefers DLHD's structured channels/schedule API. Otherwise it reads the public 24/7 catalogue and public schedule pages.

## Architecture

```text
DLHD channels + schedule ───────────┐
                                    │ desired catalogue
Provider A / line 1 (huge M3U) ─────┤
Provider A / line 2 (huge M3U) ─────┤
Provider B / line 1 (huge M3U) ─────┤
                                    ▼
                             JustOne Catalog
                       stream / match / discard
                                    │
                      matched channels/events only
                                    │
                   Docker-internal M3Us + XMLTV
                                    │
                                    ▼
                              Dispatcharr
                                    │
                                    ▼
                                Jellyfin
```

For events, JustOne first matches the event title. It can also use the specific real channels DLHD associates with the event, while generic names such as `Event Stream`, `Event SD Stream`, `Event PPV`, `Channel Not Listed` and `MultiFeed` are deliberately not reused across events.

## 300-500 MB provider playlists

Provider M3Us are parsed **incrementally from the HTTP response stream**.

JustOne does not call `response.text()` on provider playlists and does not split a 500 MB string into millions of lines in memory. The refresh order is:

```text
1. Fetch the small DLHD desired-state
2. Build one indexed matcher
3. Stream provider M3U bytes
4. Parse one EXTINF / URL pair at a time
5. Match it immediately
6. Keep only matching DLHD events or GB/PT/US channels
7. Discard everything else
```

Only the small matched catalogue remains in memory. Source status reports the scanned row count, matched row count and decoded MB processed.

Large-playlist settings:

```text
PLAYLIST_FETCH_TIMEOUT_MS=900000
PLAYLIST_MAX_LINE_LENGTH=4194304
```

## Source / failover ordering

Within a canonical channel/event, variants remain ordered breadth-first across providers/accounts before deeper variants from one credential:

```text
Provider A / account 1 / HD
Provider B / account 1 / HD
Provider A / account 2 / HD
Provider A / account 1 / backup HD
Provider B / account 1 / backup HD
...
```

Dispatcharr remains responsible for live connection limits, buffering detection and failover.

## Admin at `https://resolver.vpn4u.cc`

JustOne joins the existing external Docker network **`media_net`** and publishes only its admin listener through Traefik.

The compose file configures:

```text
Host(`resolver.vpn4u.cc`)
entrypoint = websecure
TLS = true
certresolver = le
service port = 8090
```

The JustOne router has priority `100`, so it takes precedence over an older lower-priority router using the same hostname.

Opening:

```text
https://resolver.vpn4u.cc
```

redirects to:

```text
https://resolver.vpn4u.cc/admin
```

`ADMIN_KEY` is mandatory. JustOne refuses to start if it is empty.

Direct host access remains loopback-only:

```text
http://127.0.0.1:8090/admin
```

## M3U/XMLTV remain internal-only

M3U and XMLTV output stays on port `8091` inside `media_net` only.

There is deliberately:

- no host port mapping for `8091`
- no Traefik router for `8091`
- no public M3U endpoint

Typical internal URLs are:

```text
http://justone-catalog:8091/m3u/source/<source-id>.m3u
http://justone-catalog:8091/m3u/master.m3u
http://justone-catalog:8091/epg/guide.xml
```

`GET /api/internal-outputs` returns the generated internal URLs.

Do **not** publish `8091` through Docker, Traefik or Cloudflare.

## Easy playlist management

The admin UI is designed around **paste URL → Add playlist**.

The M3U URL is the only required field. JustOne automatically defaults to:

```text
provider     = playlist hostname
account      = Line 1 / Line 2 / ...
name         = <hostname> - Line N
maxStreams   = 1
priority     = automatic
```

Advanced fields remain available when you need to override provider/account names, connection count or priority.

Each playlist has one-click:

- Enable / Disable
- Edit
- Copy internal M3U
- Remove

The UI also shows the last refresh status, number of provider rows scanned and matching output count.

### Bulk add

Paste one URL per line:

```text
https://provider-a.example/line1.m3u
https://provider-a.example/line2.m3u
https://provider-b.example/get.php?username=...&password=...
```

or optionally name them:

```text
Provider A line 1 | https://provider-a.example/line1.m3u
Provider A line 2 | https://provider-a.example/line2.m3u
Provider B | https://provider-b.example/get.php?username=...&password=...
```

Duplicate URLs are skipped.

The API equivalent is:

```text
POST /api/sources/bulk
```

## Failure behaviour

`DLHD_FAIL_CLOSED=true` is the default.

That means:

- DLHD failure never causes the full unfiltered provider list to be published
- last-known-good DLHD reference is reused when possible
- if there is no valid DLHD reference at all, refresh fails closed
- failed provider lines retain their last-known-good matched variants where allowed
- failed XMLTV sources can reuse the last-known-good generated guide

## Quick start

```bash
cp .env.example .env
# Set a long random ADMIN_KEY in .env
docker network inspect media_net >/dev/null
docker compose up -d --build
```

Then open:

```text
https://resolver.vpn4u.cc
```

A source can also be added with only a URL:

```bash
curl -X POST http://127.0.0.1:8090/api/sources \
  -H 'Authorization: Bearer YOUR_ADMIN_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://provider.example/line1.m3u"}'
```

Inspect DLHD matching with:

```bash
curl http://127.0.0.1:8090/api/dlhd \
  -H 'Authorization: Bearer YOUR_ADMIN_KEY'
```

## Dispatcharr safety

JustOne only owns Dispatcharr channels whose `tvg_id` starts with `justone.`.

Reconciliation is preview-only unless both are true:

```text
DISPATCHARR_APPLY_ENABLED=true
```

and the reconcile request explicitly contains:

```json
{"apply": true}
```

Use `/api/dispatcharr/preview` first.

## Important APIs

Admin/API listener (`8090`):

- `GET /api/catalog`
- `GET /api/dlhd`
- `GET /api/internal-outputs`
- `GET/POST /api/sources`
- `POST /api/sources/bulk`
- `PATCH/DELETE /api/sources/:id`
- `GET/POST /api/guides`
- `PUT /api/aliases`
- `PUT /api/overrides`
- `POST /api/refresh`
- `GET /api/dispatcharr/preview`
- `POST /api/dispatcharr/reconcile`

Internal listener (`8091`, `media_net` only):

- `GET /m3u/source/:sourceId.m3u`
- `GET /m3u/master.m3u`
- `GET /epg/guide.xml`

## Still deliberately absent

JustOne still contains no DLHD playback resolver, video proxy, FFmpeg remuxing, playback state machine, warm standby or stream-health probing. DLHD determines **what should exist**; your IPTV providers and Dispatcharr determine **how it plays**.
