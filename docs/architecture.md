# Architecture

JustOne is a **Live TV resolver and Jellyfin organizer**.

```text
DLStreams / DLHD
       │
       ├── channel discovery / schedule
       │
       ▼
JustOne platform
       │
       ├── validate preferred DLHD HLS down to readable media
       ├── fall back to legacy DLHD when needed
       ├── remux HLS to MPEG-TS for Jellyfin compatibility
       └── publish raw compatibility M3U feeds
       │
       ▼
Jellyfin Live organizer
       │
       ├── filter adult/non-live entries
       ├── normalize channel identity and ordering
       ├── collapse sports/event sources with failover
       └── enrich channel metadata, artwork and XMLTV
       │
       ▼
Jellyfin M3U tuner + XMLTV guide
```

The primary live backend is `dlhd-proxy`; the existing `dlhd` service remains a playback fallback. A provider is not accepted merely because its manifest returns HTTP success: JustOne follows HLS far enough to prove that media bytes are readable.

Generated Live TV/runtime files live under `RESOLVER_FILES` (by default `/mnt/resolver-files`), with the raw platform playlists under `PATH_LIVE`.
