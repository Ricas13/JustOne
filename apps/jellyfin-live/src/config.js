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

  // Optional AceStream source layer. It is disabled by default so enabling this
  // branch cannot change the known-good DLHD playback path unless explicitly
  // configured. Discovery uses the Ace Engine /search endpoint; playback goes
  // through MediaFlow Proxy only after a candidate has been verified.
  acestreamEnabled: String(process.env.ACESTREAM_ENABLED || "false").toLowerCase() === "true",
  acestreamSearchUrl: (process.env.ACESTREAM_SEARCH_URL || "http://acestream:6878/search").trim(),
  acestreamMediaflowUrl: (process.env.ACESTREAM_MEDIAFLOW_URL || "http://mediaflow-proxy:8888").replace(/\/$/, ""),
  acestreamMediaflowApiKey: process.env.ACESTREAM_MEDIAFLOW_API_KEY || "",
  acestreamStateFile: process.env.ACESTREAM_STATE_FILE || "/app/data/acestream-state.json",
  acestreamDiscoveryBatch: Number(process.env.ACESTREAM_DISCOVERY_BATCH || 75),
  acestreamPageSize: Number(process.env.ACESTREAM_PAGE_SIZE || 50),
  acestreamMaxCandidates: Number(process.env.ACESTREAM_MAX_CANDIDATES || 5),
  acestreamMinAvailability: Number(process.env.ACESTREAM_MIN_AVAILABILITY || 0.5),
  acestreamAutoVerifyMetadata: String(process.env.ACESTREAM_AUTO_VERIFY_METADATA || "false").toLowerCase() === "true",
  acestreamPriority: String(process.env.ACESTREAM_PRIORITY || "first").toLowerCase() === "fallback" ? "fallback" : "first",
};

export function withKey(url) {
  if (!config.playlistKey) return url;
  const sep = String(url).includes("?") ? "&" : "?";
  return `${url}${sep}key=${encodeURIComponent(config.playlistKey)}`;
}

export function rawPlaylistUrl() {
  return `${config.dlhdProxyUrl}/playlist.m3u8`;
}
