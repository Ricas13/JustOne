# JustOne Catalog

JustOne is a **standalone IPTV catalogue, account allocator and internal MPEG-TS playback proxy**. The target playback path is Providers → JustOne → Jellyfin. It does not remux or transcode video, and there is no FFmpeg playback path.

## Desired lineup

DLHD is the authoritative reference for what should exist.

The output policy is DLHD-authoritative:

- **all DLHD static / 24-7 channels from every country**
- **genuine standalone DLHD events / PPV streams**
- scheduled events already carried by a normal DLHD channel remain EPG metadata on that channel instead of becoming duplicate Live TV channels
- provider entries with no DLHD target are discarded

Lineup order is stable: UK first, then Portugal, then USA, then all other countries.

The country policy is controlled by:

```text
DLHD_STATIC_COUNTRIES=ALL
```

Standalone events are not country-filtered. Linear schedule events linked to an ordinary DLHD channel are attached to that channel for EPG enrichment and are not emitted as duplicate event channels.

DLHD is used only for **names, availability, event relationships and optional logos**. Actual playback always comes from your configured IPTV providers.

If `DLHD_API_KEY` is configured, JustOne prefers DLHD's structured channels/schedule API. Otherwise it reads the public 24/7 catalogue and public schedule pages.

## Provider-listed events (PPV / live-event slots)

Most IPTV providers publish every live event on a numbered slot channel and put the real title in brackets, often with a start time:

```text
US| PRIME US 007 [Canelo Alvarez vs. Christian Mbilli (2026-10-31 15:58:00)]
PPV| LIVE EVENT 02 [10am Canelo v Mbilli]
PPV| UFC [BG] 21 [CAGE WARRIORS 213 (2026-11-14 14:30:00)]
```

DLHD still decides first: a row that matches a DLHD event is handled exactly as before. Rows DLHD did not match are then considered as **provider events**, so a PPV that DLHD does not list is no longer lost:

1. Only rows in a PPV / live-event group are considered (`PROVIDER_EVENT_GROUPS`). Placeholders such as `[EVENT ONLY]`, `[NO EVENT]`, `[BK]` and `[LIVE DURING EVENTS ONLY]` are ignored.
2. Rows describing the same event (any number of slots, providers and accounts, with different spellings such as `Canelo v Mbilli` / `Canelo Alvarez vs. Christian Mbilli`) become **one** event channel with all slots as ordered failover variants. Prelims, press conferences, weigh-ins, free fights and replays stay separate events, and `UFC 334` never merges with `UFC 335`.
3. A cluster that matches a standalone DLHD event is attached to that DLHD event instead of creating a duplicate channel. Rows already mapped to a DLHD event, directly or through EPG-assisted matching, never become provider events.
4. The start time is taken from the first thing that works: a timestamp in the title (optionally with `Z` or an offset), a clock time (`10am`, `17:45 pm`, `15.00`), a weekday with a clock in either order (`Sat 7 pm`, `7:15am Sun`) or a dated time (`Sun May 4th 4:00PM`; the weekday must agree with the date), the same event on a sibling slot that has a time, or the DLHD event. If nothing in the playlist or DLHD carries a time, the event is treated as starting when JustOne first saw it (remembered across refreshes) and its guide entry says `(start time estimated)`. A clock time without a date (`10am`) keeps the day it was first resolved to, so an event that has ended does not come back as "tomorrow's". An explicit date or time that is unusable (Feb 30, a weekday that contradicts the date, an offset like `+25:00`) makes the row ineligible rather than "starting now". Times skipped by a DST change shift forward; repeated ones use the first occurrence. JustOne does not look times up anywhere else.
5. The end is the start plus a duration based on the sport (3 h by default). Every event gets its own XMLTV programme with that start/end.
6. Events are published from `PROVIDER_EVENT_LEAD_MINUTES` before the start until `PROVIDER_EVENT_TAIL_MINUTES` after the end, then drop out. At most `PROVIDER_EVENT_MAX_EVENTS` are created, keeping the events carried by the most slots first.
7. An event keeps the same id and channel identity across refreshes whichever provider row names it first; a small registry in the snapshot remembers this (at most 1000 active events, pruned after 3 days). The id is a recurring programme slot: once a title is confirmed gone and later returns it is a new occurrence (new start and window) under the same id and guide id. Two occurrences of one title at different times are different events, and a cluster never spans more than 8 hours of start times. "Confirmed gone" is recorded explicitly: a refresh in which every source that carried the listing succeeded did not see it, and more than 12 hours have passed. A failed scan never confirms that, however the source behaves afterwards, and an unrelated source being down changes nothing. Expired events whose time was only an estimate are remembered as compact tombstones keyed by the event's most specific title, so they do not come back as new, do not use up room for new events, and a generic alias shared with another event ("Night Show") cannot hide it. If the active registry is full, an estimated event that does not fit is held back and admitted later with its original first-seen time. If the tombstone table itself overflows, new estimated events are not published for a few days rather than risk resurrecting old ones. If a provider is down during a refresh, its variants stay on a published provider event until that event's window ends, and never move to a different occurrence. Expired provider events (guide ids `justone.pevent.*`) are also removed from a preserved last-known-good guide, using an XML-aware pass that leaves comments, CDATA and other channels alone.
8. Event channels have no logo of their own, so JustOne draws the same generated poster it uses for every other event (competition, `VS` badges, team initials).

Timestamps in provider titles have no time zone; they are read as `PROVIDER_EVENT_TIMEZONE` (default `UTC`, any IANA name such as `Europe/London`). Set `PROVIDER_EVENTS_ENABLED=false` to turn the feature off. The refresh log and `dlhdStatus.providerEvents` report how many events were created, attached to DLHD, expired, estimated or capped.

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

Dispatcharr integration remains available only as an optional legacy/rollback path. It is not required for Jellyfin playback.

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
6. Keep only matching DLHD static channels or genuine standalone events
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

JustOne's native proxy enforces each source's `maxStreams`, shares one upstream connection between viewers of the same canonical channel, waits for real media bytes before committing a startup source, and fails over through the existing variant order when an upstream errors, stalls or ends. Dispatcharr is not part of the normal playback path.

## Admin at `https://resolver.vpn4u.cc`

JustOne joins the existing external Docker network **`media_net`** and publishes only its admin listener through Traefik.

The compose file configures:

```text
Host(`resolver.vpn4u.cc`)
entrypoint = websecure
TLS = true
certresolver = le
service port = 8090 by default (`PORT`)
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

Direct host access remains loopback-only (default `PORT=8090`):

```text
http://127.0.0.1:8090/admin
```

## M3U/XMLTV/streams remain internal-only

M3U, XMLTV and native proxy streams stay on the internal listener (`INTERNAL_PORT=8091` by default) inside `media_net` only.

There is deliberately:

- no host port mapping for the internal listener
- no Traefik router for the internal listener
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

`GET /api/internal-outputs` returns the generated internal URLs. Proxy M3U/stream URLs use `STREAM_PROXY_KEY`; `INTERNAL_KEY` remains the independent legacy internal-output key. If `STREAM_PROXY_KEY` is empty, `INTERNAL_KEY` is accepted as a compatibility fallback.

Do **not** publish the internal listener through Docker, Traefik or Cloudflare.

## Native stream proxy

The proxy is staged only to make migration safe. The finished setup points Jellyfin directly at JustOne.

> **Migration warning:** JustOne and Dispatcharr do not share live account-occupancy state. While both are actively serving streams from the same IPTV credentials, each can independently believe a line is free and the provider's real connection limit can be exceeded. Test the JustOne tuner during a quiet window or with a dedicated provider line, then remove Dispatcharr from Jellyfin's playback path once JustOne is proven.

1. Set a long random `STREAM_PROXY_KEY`. Leave any existing `INTERNAL_KEY` unchanged during migration so legacy Dispatcharr URLs continue working.
2. Set `STREAM_PROXY_ENABLED=true` and keep `STREAM_PROXY_MASTER_ENABLED=false`.
3. In Jellyfin, add the `proxy` URL returned by `GET /api/internal-outputs` (or the **Copy proxy M3U** button) as the M3U tuner and use the returned `guide` URL as the XMLTV guide.
4. Verify playback and the **Live stream proxy** admin panel. It shows the canonical channel, provider/account, viewer count, bitrate, quality, failover count, and each account's active/max upstream connections.
5. After the proxy feed is proven, set `STREAM_PROXY_MASTER_ENABLED=true`. From then on `/m3u/master.m3u` emits one opaque JustOne relay URL per canonical channel.
6. Point Jellyfin permanently at the returned `master` URL and remove Dispatcharr from Jellyfin's playback path.

The proxy is a byte relay, not a transcoder. Its stability controls are:

- **startup validation:** Jellyfin does not receive HTTP 200 until an upstream has filled a small real-media startup buffer
- **replay buffer:** new viewers receive a bounded recent TS window instead of joining at an arbitrary packet boundary
- **shared relays:** multiple Jellyfin viewers of one channel consume one provider connection
- **connection limits:** `maxStreams` is enforced per configured provider account
- **idle grace with capacity preemption:** short Jellyfin probe/disconnect/reconnect cycles reuse the same upstream relay, but a different channel can immediately reclaim an idle grace-held account when capacity is otherwise full
- **stall detection:** an upstream that stops producing bytes is aborted
- **failover:** failed variants are cooled down and the next available ordered account/variant is tried within the configured total failover window
- **failover keepalive:** valid MPEG-TS null packets keep the established Jellyfin HTTP stream alive while a replacement upstream is opening
- **provider compatibility:** upstream requests use a VLC user agent by default and can be overridden with `STREAM_USER_AGENT`
- **credential isolation:** provider stream URLs and credentials are never emitted in the proxy M3U or live status API

The native proxy supports both direct HTTP MPEG-TS and HLS sources whose media segments are MPEG-TS. HLS master/media playlists are consumed inside JustOne, live playlists start near the live edge, relative URLs and byte ranges are resolved, and AES-128 encrypted TS segments are decrypted before entering the existing shared relay. Live HLS segments are paced against their `EXTINF` media duration so a fast CDN cannot dump several seconds of video into Jellyfin in a short burst and then go silent. fMP4/CMAF (`EXT-X-MAP`) and non-AES-128 HLS encryption remain unsupported because the byte relay does not remux media.

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

## Optional legacy Dispatcharr rollback

This integration is retained only for rollback/compatibility. JustOne only owns Dispatcharr channels whose `tvg_id` starts with `justone.`.

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

Admin/API listener (default `8090`):

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

Internal listener (default `8091`, `media_net` only):

- `GET /m3u/source/:sourceId.m3u`
- `GET /m3u/master.m3u`
- `GET /m3u/proxy.m3u`
- `GET|HEAD /stream/:channelId.ts`
- `GET /epg/guide.xml`

## Still deliberately absent

JustOne still contains no DLHD playback resolver, FFmpeg remuxing/transcoding, fMP4/CMAF-to-TS remuxing, warm-standby upstream, timeshift buffer or DVR engine. The native proxy deliberately remains a small live MPEG-TS relay/allocator rather than becoming another full IPTV server.
