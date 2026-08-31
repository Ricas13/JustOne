# Troubleshooting

## DLHD `Cannot find module './m3u8.js'`

Upstream [Lunatic16/dlhd-web](https://github.com/Lunatic16/dlhd-web) references `src/channels/m3u8.ts` but the file was never committed.

JustOne fixes this by building from `docker/dlhd/`, which clones upstream and injects our `m3u8.ts` patch.

```bash
git pull --ff-only
docker compose build dlhd --no-cache
docker compose up -d dlhd platform jellyfin-live
```

## Check Live TV services

```bash
docker compose ps
curl -s http://127.0.0.1:18080/health
curl -s http://127.0.0.1:18080/live/status
```

## Force a channel to re-resolve

Use the local platform endpoint so the playlist key is not required from loopback:

```bash
curl -i --max-time 20 'http://127.0.0.1:18080/play/live/49.ts?refresh=1'
```

A healthy MPEG-TS handoff returns `Content-Type: video/mp2t`. If the preferred DLHD proxy has a dead manifest or dead media segment, JustOne tries the legacy DLHD backend before failing the request.
