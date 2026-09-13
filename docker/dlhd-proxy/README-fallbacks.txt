Optional direct fallback configuration is read from /app/data/direct-fallbacks.json.

The file is a JSON object keyed by channel ID. Each value may be one URL string,
an object with url/referer/origin fields, or a list of those values. Up to eight
fallback sources are tried in order.

Jellyfin tries the normal provider player slots first. Only after those fail does
it request /fallback/<channel>.m3u8 from JustOne. The fallback response is still
rewritten through JustOne's HLS proxy so child playlists and media segments keep
the configured Referer/Origin context.

If no file exists, JustOne behaves exactly as before and the fallback endpoint
returns 404.
