# Architecture

JustOne is an **admin resolver**, not a video proxy.

```
Jellyfin / Stremio / IPTVEditor
        │
        │  .strm or M3U URL
        ▼
JustOne resolver  --JSON/HTTP-->  CinePro (VOD) or live backend
        │
        │  302 Location: https://cdn/...
        ▼
Player talks to the CDN. No video bytes on JustOne.
```

STRM names follow TRaSH / Jellyfin (`[tmdbid-…]` / `[tvdbid-…]`) in four trees: movies-1080p, movies-4k, tv-1080p, tv-4k.

Live M3U is IPTVEditor-shaped (`url-tvg`, `tvg-id`, `tvg-name`, `tvg-logo`, `tvg-chno`, `group-title`). Channel list is refreshed on an interval and when `/live/refresh` or `?refresh=1` is used.
