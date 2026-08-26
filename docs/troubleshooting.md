# Troubleshooting

## dlhd `Cannot find module './m3u8.js'`

Upstream [Lunatic16/dlhd-web](https://github.com/Lunatic16/dlhd-web) references `src/channels/m3u8.ts` but the file was never committed.

JustOne fixes this by building from `docker/dlhd/`, which clones upstream and injects our `m3u8.ts` patch.

```bash
git pull
docker compose build dlhd --no-cache
docker compose up -d
```

## CinePro pull issues

```bash
docker pull ghcr.io/cinepro-org/core:latest
```

Ensure `TMDB_API_KEY` is set in `.env`.

## Check services

```bash
docker compose ps
curl -s http://localhost:8080/health
curl -s http://localhost:3001/api/channels | head
curl -sI http://localhost:7000/manifest.json
```
