HLS proxy requests now derive Origin from the stored Referer when the token has no explicit Origin.
Media playlists that advertise EXTINF durations but contain no media URIs are rejected as retryable upstream failures instead of being passed to FFmpeg.
