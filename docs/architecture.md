# Architecture

JustOne is the **control plane**. Scrapers stay in their own containers.

```
Browser / Stremio / Jellyfin
            │
     JustOne platform (UI, API, STRM, proxy, M3U)
        │                    │
   CinePro Core          dlhd-web
   (movies/series)       (live TV)
            │
     Stremio addon (catalog + stream)
```

## Services

1. **platform** — Hub UI, health, VOD/live proxy, STRM writer, live M3U, unified Stremio manifest pointer.
2. **stremio-addon** — Catalog / meta / stream for movies, series, and live TV.
3. **cinepro** — Official OMSS image. Optional but required for VOD resolve.
4. **dlhd** — Live channel list + HLS resolve. Optional but required for a full live grid.

## STRM

`.strm` files contain a **JustOne proxy URL**, not a raw third-party link. When a token dies, you re-resolve without rewriting Jellyfin’s library layout.

## Local vs Traefik

Compose publishes ports 8080 / 3000 / 3001 / 7000 for local use. Traefik labels are included if you already run a reverse proxy; the `justone` network is created by Compose (no external network required).
