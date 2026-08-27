# JustOne

Admin control plane for a **personal** Jellyfin + Stremio stack.

1. Generate thousands of TRaSH-named `.strm` files (1080p and 4K trees).
2. Jellyfin plays a `.strm` → **resolver** asks CinePro for a working source → **HTTP 302** to that URL. Video bytes never pass through JustOne.
3. Live TV M3U from the live backend, IPTVEditor-compatible. Same 302 resolver per channel.
4. Optional Stremio addon: resolve, then give the player the **direct** URL.

> Personal / educational use only. You are responsible for what backends you connect and for applicable law.

## Deploy (Traefik + Let's Encrypt)

Production compose is built for:

- Host: **`resolver.vpn4u.cc`**
- Docker network: **`media_net`** (external, Traefik already on it)
- TLS: Traefik cert resolver **`le`**

See [docs/traefik.md](docs/traefik.md).

```bash
cp .env.example .env   # TMDB_API_KEY + TRAEFIK_CERTRESOLVER
docker compose up -d --build
```

| URL | Use |
| --- | --- |
| `https://resolver.vpn4u.cc/` | Admin |
| `https://resolver.vpn4u.cc/resolve/movie/{id}?quality=4k` | STRM target (302) |
| `https://resolver.vpn4u.cc/live/playlist.m3u8` | IPTVEditor / Jellyfin Live |
| `https://resolver.vpn4u.cc/stremio/manifest.json` | Stremio |

## Libraries (TRaSH / Jellyfin)

```text
data/library/
  movies-1080p/Movie Title (2024) [tmdbid-123]/Movie Title (2024) [tmdbid-123].strm
  movies-4k/...
  tv-1080p/Show Name (2022) [tvdbid-456]/Season 01/Show Name (2022) - S01E01 - Episode Title.strm
  tv-4k/...
```

Each `.strm` is one line: `https://resolver.vpn4u.cc/resolve/movie/123?quality=4k`

## License

See LICENSE. Not affiliated with CinePro, Stremio, Jellyfin, or TRaSH Guides.
