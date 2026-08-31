# Jellyfin Live TV setup

JustOne exposes a normalized M3U lineup and XMLTV guide specifically for Jellyfin.

1. In Jellyfin, open **Dashboard → Live TV → Tuner Devices**.
2. Add an **M3U Tuner** using:

   ```text
   https://YOUR_JUSTONE_HOST/jellyfin/playlist.m3u8?key=YOUR_PLAYLIST_KEY
   ```

3. Under **TV Guide Data Providers**, add an **XMLTV** source using:

   ```text
   https://YOUR_JUSTONE_HOST/jellyfin/guide.xml?key=YOUR_PLAYLIST_KEY
   ```

4. Run Jellyfin's guide refresh after changing lineup or guide settings.

The Jellyfin organizer removes adult and non-live groups, normalizes channel identity, preserves sports/event failover, and enriches the lineup with guide/artwork metadata. Raw compatibility feeds remain available under `/live/`, but the `/jellyfin/` endpoints are the recommended Jellyfin configuration.
