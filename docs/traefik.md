# Deploy behind Traefik — resolver.vpn4u.cc

Only **justone-platform** is attached to `media_net`. CinePro, live, and Stremio stay on the internal `justone` network with `traefik.enable=false`. That stops Fastify/CinePro from answering `GET /` on the public host.

If you already saw JSON `Route GET:/ not found` at https://resolver.vpn4u.cc/ — that was CinePro (or another Fastify app) winning the Traefik router. Pull this compose, then recreate.

## Apply

```bash
cd JustOne
git pull
docker compose up -d --build --force-recreate --remove-orphans
```

Healthy admin UI is HTML (JustOne), not JSON. Confirm:

```bash
curl -sI https://resolver.vpn4u.cc/ | grep -i x-justone
# x-justone: platform
```

If that header is missing, Traefik is still routing the host to another container. Check Traefik routers for `Host(resolver.vpn4u.cc)` and disable the old one (file provider or leftover labels).

## What must already exist

1. Traefik on Docker network **`media_net`**
2. DNS `resolver.vpn4u.cc` → Traefik host
3. Entrypoint **`websecure`**, cert resolver **`le`** (override with `TRAEFIK_CERTRESOLVER`)

## Routes (all on the platform container)

| URL | Use |
| --- | --- |
| `https://resolver.vpn4u.cc/` | Admin |
| `https://resolver.vpn4u.cc/health` | `{ "service": "justone-platform" }` |
| `https://resolver.vpn4u.cc/resolve/movie/{id}?quality=4k` | 302 resolver |
| `https://resolver.vpn4u.cc/live/playlist.m3u8` | IPTVEditor / Jellyfin |
| `https://resolver.vpn4u.cc/stremio/manifest.json` | Stremio |
