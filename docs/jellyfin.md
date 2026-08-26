# Jellyfin setup

## Movies & TV (`.strm`)

1. Ensure JustOne has written files under:
   - `data/library/movies/`
   - `data/library/tv/`
2. In Jellyfin **Dashboard → Libraries**:
   - Add **Movies** → folder mounted to `.../movies`
   - Add **Shows** → folder mounted to `.../tv`
3. Use standard Jellyfin naming so metadata matches:
   - `Movie Name (2020)/Movie Name (2020).strm`
   - `Show Name/Season 01/Show Name - S01E01.strm`
4. Prefer **TMDB** as the metadata provider.

### Playback notes

- `.strm` files contain a single URL (JustOne proxy recommended).
- If playback fails, re-resolve the title in JustOne (refresh job) rather than editing the file by hand.
- Some clients need “allows remote media” / similar options enabled.

## Live TV (M3U)

1. **Dashboard → Live TV → Tuners**
2. Add **M3U Tuner** with URL:
   ```text
   http://JUSTONE_HOST:8080/live/playlist.m3u8
   ```
3. Optional EPG: wire an XMLTV source if you add one later.

## Docker volume tip

Mount the same host path into both JustOne and Jellyfin so scans see new `.strm` files immediately:

```yaml
# jellyfin snippet
volumes:
  - /path/to/JustOne/data/library:/media/justone:ro
```
