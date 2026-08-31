# Traefik on this host

Install at **`/opt/JustOne`** (not `/opt/JustOne/JustOne`).

- File provider: `/opt/traefik/dynamic`
- Docker provider: `exposedbydefault=false`
- Entrypoint: `websecure` · cert resolver: `le`
- Traefik networks: `media_net`, `captainfin_proxy`

```bash
cd /opt/JustOne
git pull --ff-only
docker compose up -d --build --remove-orphans
sudo cp /opt/JustOne/traefik/justone.yml /opt/traefik/dynamic/justone.yml
```

Public DNS for `resolver.vpn4u.cc` must point to the machine running the JustOne Live TV stack.
