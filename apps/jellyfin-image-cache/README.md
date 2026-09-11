# Jellyfin image cache gateway

This service sits in front of `jellyfin-live` and rewrites remote channel/programme image URLs in M3U/XMLTV metadata to stable JustOne-local cache URLs.

Key behaviours:

- Persistent disk cache across container restarts.
- Stable SHA-256 cache identity per normalized source URL.
- Repairs the observed concatenated absolute-URL defect from XMLTV sources.
- Single-flight upstream fetches with bounded global concurrency.
- 30-day positive cache by default.
- 6-hour negative cache for 404/429/timeout/invalid-image failures.
- Stale cached images remain usable while refresh happens in the background.
- First-fetch failures return a local PNG placeholder with HTTP 200 so Jellyfin guide refresh cannot fail because an image host is broken or rate-limited.
- Remote redirects are revalidated before being followed.
- Literal private-network/loopback image targets are rejected.
- Playback URLs and event-selector redirects are proxied unchanged.

Health and counters are exposed at `/jellyfin/image-cache/health`.
