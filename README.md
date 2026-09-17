# JustOne Catalog

JustOne is an **IPTV catalogue/control plane** with an optional internal MPEG-TS byte proxy. It does not remux or transcode video, and there is still no FFmpeg playback path.

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
                     canonical channels + variants
                                    │
                         Native stream allocator
                    maxStreams / sharing / failover
                                    │
                         opaque internal M3U
                                    │
                                    ▼
                                Jellyfin
```

Dispatcharr integration remains available as a legacy/rollback path while the native proxy is being proven.

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
PLAYLIST_FETCH_TIMEOUT_MS=1800000
PLAYLIST_MAX_LINE_LENGTH=4194304
```

The default timeout is 30 minutes per provider source. Sources are scanned sequentially so several giant playlists do not compete for RAM and bandwidth at the same time.

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

When the native proxy is enabled, JustOne enforces each source's `maxStreams`, shares one upstream connection between viewers of the same canonical channel, waits for real media bytes before committing a startup source, and fails over through the existing variant order when an upstream errors, stalls or ends. Dispatcharr can remain configured as a compatibility/rollback path.

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

## M3U/XMLTV/streams remain internal-only

M3U, XMLTV and native proxy streams stay on port `8091` inside `media_net` only.

There is deliberately:

- no host port mapping for `8091`
- no Traefik router for `8091`
- no public M3U or native stream endpoint
- no provider URL in the proxy M3U

Typical internal URLs are:

```text
http://justone-catalog:8091/m3u/source/<source-id>.m3u
http://justone-catalog:8091/m3u/master.m3u
http://justone-catalog:8091/m3u/proxy.m3u
http://justone-catalog:8091/stream/<channel-id>.ts
http://justone-catalog:8091/epg/guide.xml
```

`GET /api/internal-outputs` returns the generated internal URLs. When the native proxy is enabled, `INTERNAL_KEY` is mandatory and is appended to the internal bearer URLs.

Do **not** publish `8091` through Docker, Traefik or Cloudflare.

## Native stream proxy

The proxy is intentionally staged so existing Dispatcharr playback is not replaced in one step.

1. Set a long random `INTERNAL_KEY`.
2. Set `STREAM_PROXY_ENABLED=true` and keep `STREAM_PROXY_MASTER_ENABLED=false`.
3. Use the `proxy` URL returned by `GET /api/internal-outputs` (or the **Copy proxy M3U** button) as a test Jellyfin tuner.
4. Verify playback and the **Live stream proxy** admin panel. It shows the canonical channel, provider/account, viewer count, bitrate, quality, failover count, and each account's active/max upstream connections.
5. After the proxy feed is proven, set `STREAM_PROXY_MASTER_ENABLED=true`. From then on `/m3u/master.m3u` emits one opaque JustOne relay URL per canonical channel.

The proxy is a byte relay, not a transcoder. Its stability controls are:

- **startup validation:** Jellyfin does not receive HTTP 200 until an upstream has filled a small real-media startup buffer
- **replay buffer:** new viewers receive a bounded recent TS window instead of joining at an arbitrary packet boundary
- **shared relays:** multiple Jellyfin viewers of one channel consume one provider connection
- **connection limits:** `maxStreams` is enforced per configured provider account
- **idle grace:** short Jellyfin probe/disconnect/reconnect cycles reuse the same upstream relay
- **stall detection:** an upstream that stops producing bytes is aborted
- **failover:** failed variants are cooled down and the next available ordered account/variant is tried
- **failover keepalive:** valid MPEG-TS null packets keep the established Jellyfin HTTP stream alive while a replacement upstream is opening
- **provider compatibility:** upstream requests use a VLC user agent by default and can be overridden with `STREAM_USER_AGENT`
- **credential isolation:** provider stream URLs and credentials are never emitted in the proxy M3U or live status API

The first version supports direct HTTP MPEG-TS-style live streams. HLS manifests (`.m3u8`) are deliberately not rewritten yet; if a candidate is HLS it is treated as unsupported and the allocator tries the next candidate.

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

The UI also shows the last refresh status and provider row count.

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
- `GET /api/streams`
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
- `GET /m3u/proxy.m3u`
- `GET|HEAD /stream/:channelId.ts`
- `GET /epg/guide.xml`

## Still deliberately absent

JustOne still contains no DLHD playback resolver, FFmpeg remuxing/transcoding, HLS manifest/segment rewriting, warm-standby upstream, timeshift buffer or DVR engine. The native proxy deliberately remains a small live MPEG-TS relay/allocator rather than becoming another full IPTV server.
