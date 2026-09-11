export const config = {
  port: Number(process.env.JELLYFIN_LIVE_PORT || 8090),
  publicUrl: (process.env.PUBLIC_URL || "http://localhost:8090").replace(/\/$/, ""),
  dlhdProxyUrl: (process.env.DLHD_PROXY_URL || "http://dlhd-proxy:3000").replace(/\/$/, ""),
  playlistKey: process.env.PLAYLIST_KEY || "",
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

export function rawPlaylistUrl() {
  return `${config.dlhdProxyUrl}/playlist.m3u8`;
}
