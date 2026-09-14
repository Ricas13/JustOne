# JustOne Catalog

JustOne is now a **control-plane service for IPTV metadata and Dispatcharr channel reconciliation**.

It deliberately does **not** proxy, remux, transcode, probe, or play video. There is no FFmpeg in this project.

## Architecture

```text
Provider M3Us
    ↓
JustOne Catalog
  - canonical channel identity
  - duplicate/variant classification
  - provider/account awareness
  - EPG matching
  - logo enrichment
  - deterministic failover ordering
    ↓
per-source curated M3Us ──→ Decypharr / connection layer ──→ Dispatcharr
    │                                                        │
    └──────────────── XMLTV / logos ─────────────────────────┴─→ Jellyfin
```

The important model is:

```text
channel → source families/accounts → quality/backup variants
```

For example, five BBC One URLs from one 1-connection account are kept as variants of one source family, not treated as five independent providers.

## Failover ordering

JustOne orders streams **breadth-first across independent providers/accounts before going deeper into variants**.

With `A1`, `A2` from Provider A and `B1` from Provider B, each containing HD and FHD BBC One variants, the desired order is:

```text
A1 HD
B1 HD
A2 HD
A1 FHD
B1 FHD
A2 FHD
```

That avoids burning through every alternative from one dead provider before trying another failure domain. Dispatcharr remains responsible for real-time capacity, buffering detection and stream switching.

## Outputs

- `GET /m3u/source/:sourceId.m3u` — curated M3U for one IPTV credential/line
- `GET /m3u/master.m3u` — all curated variants, mainly for inspection
- `GET /epg/guide.xml` — canonical XMLTV guide for Jellyfin
- `GET /api/catalog` — current canonical catalogue and ordered variants
- `GET /api/dispatcharr/preview` — dry-run reconciliation plan
- `POST /api/dispatcharr/reconcile` with `{"apply":true}` — apply the plan when explicitly enabled

Every output stream receives the canonical `tvg-id`, clean channel name/logo/group, plus an internal rank marker in the stream display name, e.g.:

```text
BBC One [JO:001] [HD]
BBC One [JO:004] [FHD]
```

The rank marker is for the reconciler. The actual Dispatcharr/Jellyfin channel name remains clean (`BBC One`).

## Quick start

```bash
cp .env.example .env
# set ADMIN_KEY and PUBLIC_URL
docker compose up -d --build
```

Open `http://localhost:8090/admin` for the built-in source/EPG manager, or use the API below.

The service creates `/data/state.json` on first start.

Add a source:

```bash
curl -X POST http://localhost:8090/api/sources \
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

Add another credential as another source. There is no configured source-count limit.

Add XMLTV:

```bash
curl -X POST http://localhost:8090/api/guides \
  -H 'Authorization: Bearer change-me' \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"UK Guide",
    "priority":10,
    "url":"https://example.com/guide.xml",
    "enabled":true
  }'
```

Then refresh:

```bash
curl -X POST http://localhost:8090/api/refresh \
  -H 'Authorization: Bearer change-me'
```

## Suggested flow with Decypharr and Dispatcharr

1. Add each provider credential/line to JustOne as a separate source.
2. Feed `/m3u/source/<id>.m3u` into the connection-management layer for that line.
3. Add those resulting M3Us to Dispatcharr as separate M3U accounts/profiles with their real connection limits.
4. Ensure `tvg-id` and the JustOne rank marker survive the connection layer.
5. Review `/api/dispatcharr/preview`.
6. Set `DISPATCHARR_APPLY_ENABLED=true` only after the preview is correct.
7. Apply reconciliation.
8. Give Jellyfin the Dispatcharr playback M3U and JustOne `/epg/guide.xml`.

## Dispatcharr safety

JustOne only owns channels whose `tvg_id` starts with `justone.`. It does not delete unrelated Dispatcharr channels.

Reconciliation defaults to a **preview**. Applying changes requires both:

```text
DISPATCHARR_APPLY_ENABLED=true
```

and an explicit request body:

```json
{"apply": true}
```

Authentication supports either a Dispatcharr API key or JWT login credentials. Current Dispatcharr REST resources used are the official channel, stream, group and logo APIs.

## Metadata policy

For channel identity, quality tags (`HD`, `FHD`, `UHD`, `SD`) and backup markers are stripped before canonical matching. Manual aliases and overrides can correct edge cases without changing provider playlists.

Logo precedence is:

```text
manual override → matched XMLTV logo → provider logo
```

XMLTV matching first tries provider `tvg-id` values and then normalized channel names. Programme XML is preserved and remapped onto the canonical JustOne `tvg-id`.

## State API

- `GET /api/state`
- `GET/POST /api/sources`
- `PATCH/DELETE /api/sources/:id`
- `GET/POST /api/guides`
- `PATCH/DELETE /api/guides/:id`
- `PUT /api/aliases`
- `PUT /api/overrides`
- `POST /api/refresh`

Aliases are keyed by normalized incoming channel name and map to the canonical display name. Overrides may be keyed by canonical channel id or canonical key and can set `name`, `group`, `logo`, `number`, or `disabled`.

## What was removed

The rebuild intentionally removes the previous:

- DLHD resolver/proxy
- FFmpeg playback/remux path
- playback state machine
- stall monitoring
- rolling buffers
- source learning/scoring
- warm standby
- video proxy endpoints

Those concerns belong in Dispatcharr or the upstream connection layer, not in the catalogue.
