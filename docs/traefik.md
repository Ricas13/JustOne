# Traefik on this host

Install at **`/opt/JustOne`** (not `/opt/JustOne/JustOne`).

- File provider: `/opt/traefik/dynamic`
- Docker provider: `exposedbydefault=false`
- Entrypoint: `websecure` · cert resolver: `le`
- Traefik networks: `media_net`, `captainfin_proxy`

```bash
cd /opt/JustOne
git pull
docker compose up -d --build
sudo cp /opt/JustOne/traefik/justone.yml /opt/traefik/dynamic/justone.yml
```

Public DNS for `resolver.vpn4u.cc` must be **this** machine, not the old CinePro host (`85.17.179.27`).
