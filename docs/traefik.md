# Deploy behind Traefik — resolver.vpn4u.cc

JustOne does **not** run Traefik. It joins your existing `media_net` and sets labels so Traefik issues a Let's Encrypt cert and routes HTTPS.

## What must already exist

1. Traefik is running and attached to Docker network **`media_net`**.
2. DNS: `resolver.vpn4u.cc` A/AAAA (or CNAME) → the Traefik host.
3. Traefik entrypoint **`websecure`** (443) and a cert resolver named **`le`**. If yours is `letsencrypt` or `cloudflare`, set `TRAEFIK_CERTRESOLVER` in `.env`.
4. Traefik must watch Docker (`providers.docker`) and use `media_net` (or set `traefik.docker.network`).

## Routes

| URL | Service |
| --- | --- |
| `https://resolver.vpn4u.cc/` | Admin + resolver (`/resolve/…`, `/live/playlist.m3u8`) |
| `https://resolver.vpn4u.cc/stremio/manifest.json` | Stremio addon |
| `https://resolver.vpn4u.cc/cinepro/` | CinePro (only if a 302 lands on CinePro itself) |

Live backend stays internal. Video after a 302 goes to the CDN, not through JustOne.

## Apply

```bash
git clone https://github.com/Ricas13/JustOne.git
cd JustOne
cp .env.example .env
# set TMDB_API_KEY; confirm TRAEFIK_CERTRESOLVER matches Traefik

docker compose up -d --build
```

Then:

- Admin: `https://resolver.vpn4u.cc/`
- M3U (IPTVEditor / Jellyfin): `https://resolver.vpn4u.cc/live/playlist.m3u8`
- Stremio: `https://resolver.vpn4u.cc/stremio/manifest.json`
- STRM lines: `https://resolver.vpn4u.cc/resolve/movie/{tmdbId}?quality=4k`

Point Jellyfin libraries at the same bind as `LIBRARY_BIND` (default `./data/library` on the compose host): `movies-1080p`, `movies-4k`, `tv-1080p`, `tv-4k`.

## If the cert never appears

- Cert resolver name mismatch (`le` vs `letsencrypt`)
- Traefik not on `media_net`
- Missing `traefik.docker.network=media_net` (already in compose)
- HTTP-01 needs port 80 on Traefik; DNS-01 needs the DNS provider token in Traefik
