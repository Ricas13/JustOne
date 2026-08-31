# JustOne

JustOne is a Live TV resolver and Jellyfin lineup/EPG organizer.

It discovers DLStreams/DLHD channels, validates live media before playback, falls back between live providers, normalizes the lineup for Jellyfin, and publishes XMLTV guide data.

## Setup

```bash
cp .env.example .env
docker compose up -d --build
```

## License

See `LICENSE`.
