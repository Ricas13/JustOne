# Troubleshooting

## `ghcr.io/lunatic16/dlhd-web:latest` denied

Expected. There is no public image. Compose builds from:

`https://github.com/Lunatic16/dlhd-web.git`

If git build fails (network, private, Dockerfile issues), clone manually:

```bash
cd /opt
git clone https://github.com/Lunatic16/dlhd-web.git
cd /opt/JustOne
```

Then in `docker-compose.yml` set:

```yaml
  dlhd:
    build:
      context: /opt/dlhd-web
    image: justone-dlhd:local
```

## CinePro pull interrupted

Retry:

```bash
docker pull ghcr.io/cinepro-org/core:latest
docker compose up -d --build
```

Ensure `TMDB_API_KEY` is set in `.env`.

## Build context from GitHub URL not supported

Older Docker may not support remote git contexts. Use the manual clone method above.

## Check services

```bash
docker compose ps
curl -s http://localhost:8080/health | jq
curl -sI http://localhost:3000
curl -sI http://localhost:3001
curl -sI http://localhost:7000/manifest.json
```
