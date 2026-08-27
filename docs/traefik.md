# Deploy behind Traefik — resolver.vpn4u.cc

## What is answering the host today

`https://resolver.vpn4u.cc/health` currently returns:

```json
{"status":"ok","providers":17}
```

That is **CinePro** (Fastify). JustOne's health is `{"service":"justone-platform",...}` and `/` is HTML. Until those change, Traefik is still sending the host to the old CinePro container — compose labels never reached it.

## 1. Start JustOne (platform must exist)

```bash
cd JustOne
git pull
docker compose up -d --build --force-recreate --remove-orphans
docker compose ps
```

You need a running container named **`justone-platform`**, on network **`media_net`**.

```bash
docker inspect justone-platform --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
# must include media_net
```

## 2. Find who still owns the hostname

```bash
docker ps --format '{{.Names}}\t{{.Image}}'
```

Look for an older `cinepro` / OMSS container. Inspect Traefik labels:

```bash
docker ps -q | xargs -I{} docker inspect {} \
  --format '{{.Name}} {{index .Config.Labels "traefik.http.routers"}}' 
# or:
docker ps -q | while read id; do
  echo "==== $(docker inspect -f '{{.Name}}' $id)"
  docker inspect "$id" --format '{{range $k,$v := .Config.Labels}}{{println $k "=" $v}}{{end}}' \
    | grep -i traefik || true
done
```

Anything with `Host(\`resolver.vpn4u.cc\`)` that is **not** `justone-platform` must lose those labels (or be stopped).

If Traefik uses a **file** router for this host, edit/remove that YAML. File routers ignore Docker labels.

## 3. Force the route (file provider)

Copy [traefik/justone.yml](../traefik/justone.yml) into Traefik's dynamic directory (often `/etc/traefik/dynamic/`). Reload Traefik.

Priority is 10000 so it wins over leftover CinePro routers. Change `certResolver: le` if yours is `letsencrypt`.

Traefik and `justone-platform` must both be on `media_net` so Traefik can reach `http://justone-platform:8080`.

## 4. Confirm

```bash
curl -sI https://resolver.vpn4u.cc/ | grep -i x-justone
# x-justone: platform

curl -s https://resolver.vpn4u.cc/health
# {"service":"justone-platform", ...}
```

`{"providers":17}` means you are still on CinePro.
