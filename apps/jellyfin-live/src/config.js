export const config = {
  port: Number(process.env.JELLYFIN_LIVE_PORT || 8090),
  publicUrl: (process.env.PUBLIC_URL || "https://resolver.vpn4u.cc").replace(/\/$/, ""),
  platformUrl: (process.env.PLATFORM_URL || "http://platform:8080").replace(/\/$/, ""),
  playlistKey: process.env.PLAYLIST_KEY || "",
  streamSigningSecret: process.env.STREAM_SIGNING_SECRET || "",
  streamTokenTtlSeconds: Math.max(300, Number(process.env.STREAM_TOKEN_TTL_SECONDS || 86400)),
  dlstreamsHome: process.env.DLSTREAMS_HOME || "https://dlstreams.st/",
  refreshMin: Number(process.env.JELLYFIN_REFRESH_MIN || 10),
  epgCacheMin: Number(process.env.JELLYFIN_EPG_CACHE_MIN || 60),
  epgMaxSources: Number(process.env.JELLYFIN_EPG_MAX_SOURCES || 12),
  autoEpg: String(process.env.JELLYFIN_AUTO_EPG || "true") !== "false",
  excludeAdult: String(process.env.JELLYFIN_EXCLUDE_ADULT || "true") !== "false",
  epgSourceUrls: String(process.env.JELLYFIN_EPG_SOURCE_URLS || process.env.EPG_URL || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

export function withKey(url) {
  if (!config.playlistKey) return url;
  const sep = String(url).includes("?") ? "&" : "?";
  return `${url}${sep}key=${encodeURIComponent(config.playlistKey)}`;
}

export function rawPlaylistUrl(refresh = false) {
  const u = new URL(`${config.platformUrl}/live/playlist.m3u8`);
  if (config.playlistKey) u.searchParams.set("key", config.playlistKey);
  if (refresh) u.searchParams.set("refresh", "1");
  return u.href;
}
