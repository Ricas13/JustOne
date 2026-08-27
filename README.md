# JustOne

Admin control plane for a **personal** Jellyfin + Stremio stack.

1. Generate thousands of TRaSH-named `.strm` files (1080p and 4K trees).
2. Jellyfin plays a `.strm` → **resolver** asks CinePro for a working source → **HTTP 302** to that URL. Video bytes never pass through JustOne.
3. Live TV M3U from the live backend, IPTVEditor-compatible. Same 302 resolver per channel.
4. Optional Stremio addon: resolve, then give the player the **direct** URL.

> Personal / educational use only. You are responsible for what backends you connect and for applicable law.

## Deploy (Traefik + Let's Encrypt)

Path on the server: **`/opt/JustOne`**

- Host: **`resolver.vpn4u.cc`**
- Docker network: **`media_net`**
- TLS: Traefik cert resolver **`le`**

See [docs/traefik.md](docs/traefik.md).

```bash
cd /opt/JustOne
cp .env.example .env   # TMDB_API_KEY
docker compose up -d --build
sudo cp traefik/justone.yml /opt/traefik/dynamic/justone.yml
```

DNS for `resolver.vpn4u.cc` must point at this host.

| URL | Use |
| --- | --- |
| `https://resolver.vpn4u.cc/` | Admin |
| `https://resolver.vpn4u.cc/resolve/movie/{id}?quality=4k` | STRM target (302) |
| `https://resolver.vpn4u.cc/live/playlist.m3u8` | IPTVEditor / Jellyfin Live |
| `https://resolver.vpn4u.cc/stremio/manifest.json` | Stremio |

## Libraries (TRaSH / Jellyfin)

On first start (and `POST /library/generate`) JustOne writes:

```text
/mnt/resolver-files/Movies/Movies/Title (Year) [tmdbid-123]/Title (Year) [tmdbid-123].strm
/mnt/resolver-files/Movies/Movies-4K/...
/mnt/resolver-files/TV/TV/Show (Year) [tvdbid-456]/Season 01/Show (Year) - S01E01.strm
/mnt/resolver-files/TV/TV-4K/...
/mnt/resolver-files/Live/playlist.m3u8
```

CinePro is not a catalog. Titles come from TMDB; at play the resolver asks CinePro for a working URL (all current providers) and 302s the player. Live M3U is every dlhd channel.

Point four Jellyfin libraries at the four media folders. Tuner M3U: `https://resolver.vpn4u.cc/live/playlist.m3u8` or the file on disk.


## License

See LICENSE. Not affiliated with CinePro, Stremio, Jellyfin, or TRaSH Guides.
