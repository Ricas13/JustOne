Optional direct fallback configuration is read from /app/data/direct-fallbacks.json.

The file is a JSON object keyed by channel ID. Each value may be one URL string,
an object with url/referer/origin fields, or a list of those objects.

If no file exists, JustOne behaves exactly as before and Jellyfin simply skips the
fallback endpoint after the normal provider source slots fail.
