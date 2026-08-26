# Traefik setup (resolver.vpn4u.cc)

## Assumptions

- External Docker network: `media_net` (Traefik is already attached to it)
- Host: `resolver.vpn4u.cc`
- Entrypoint: `websecure` (change via `TRAEFIK_ENTRYPOINT`)
- Cert resolver: `letsencrypt` (change via `TRAEFIK_CERTRESOLVER`)

If your Traefik uses different names (e.g. `https`, `cloudflare`), set them in `.env`.

## Routes

| Path | Service |
|------|---------|
| `https://resolver.vpn4u.cc/` | platform (API, M3U, STRM, health) |
| `https://resolver.vpn4u.cc/stremio-live/` | Live TV Stremio addon |
| `https://resolver.vpn4u.cc/cinepro/` | CinePro Core |
| `https://resolver.vpn4u.cc/dlhd/` | dlhd-web (optional) |

## Stremio install URLs

- Live: `https://resolver.vpn4u.cc/stremio-live/manifest.json`
- VOD: `https://resolver.vpn4u.cc/cinepro/stremio/manifest.json`

## Jellyfin Live TV

M3U: `https://resolver.vpn4u.cc/live/playlist.m3u8`

## .env essentials

```bash
PUBLIC_URL=https://resolver.vpn4u.cc
CINEPRO_PUBLIC_URL=https://resolver.vpn4u.cc/cinepro
TRAEFIK_HOST=resolver.vpn4u.cc
TRAEFIK_ENTRYPOINT=websecure
TRAEFIK_CERTRESOLVER=letsencrypt
TMDB_API_KEY=...
```

## Apply

```bash
cd /opt/JustOne
git pull
# update .env as above
docker compose down
docker compose up -d --build
```

Confirm Traefik sees the containers (`traefik` dashboard or API). DNS for `resolver.vpn4u.cc` must point at the Traefik host.
