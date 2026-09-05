export const config = {
  port: Number(process.env.PLATFORM_PORT || 8080),
  publicUrl: (process.env.PUBLIC_URL || "https://resolver.vpn4u.cc").replace(/\/$/, ""),
  playbackUrl: (process.env.PLAYBACK_URL || process.env.PUBLIC_URL || "https://resolver.vpn4u.cc").replace(/\/$/, ""),
  jellyfinLiveUrl: (process.env.JELLYFIN_LIVE_URL || "http://jellyfin-live:8090").replace(/\/$/, ""),
  dlhdProxyUrl: (process.env.DLHD_PROXY_URL || "").replace(/\/$/, ""),
  dlhdUrl: (process.env.DLHD_URL || "http://dlhd:3000").replace(/\/$/, ""),
  dlstreams247: process.env.DLSTREAMS_247 || "https://dlstreams.st/24-7-channels.php",
  dlstreamsHome: process.env.DLSTREAMS_HOME || "https://dlstreams.st/",
  liveDir: process.env.PATH_LIVE || "/mnt/resolver-files/Live",
  epgUrl: process.env.EPG_URL || "",
  liveRefreshMin: Math.max(1, Number(process.env.LIVE_REFRESH_MIN || 360)),
  adminPassword: process.env.ADMIN_PASSWORD || "",
  playlistKey: process.env.PLAYLIST_KEY || "",
  streamSigningSecret: process.env.STREAM_SIGNING_SECRET || "",
  streamTokenTtlSeconds: Math.max(300, Number(process.env.STREAM_TOKEN_TTL_SECONDS || 86400)),
};

export function withKey(url) {
  let value = String(url);

  // Renewable HLS children must always remain relative to the manifest origin.
  // That guarantees FFmpeg entering through 127.0.0.1 stays on loopback and a
  // public client entering through HTTPS stays public, without ever baking a
  // specific origin into the renewable child URL.
  try {
    const parsed = new URL(value, "http://justone.invalid");
    if (parsed.pathname.startsWith("/play/renew/")) {
      value = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    /* leave malformed/non-URL values untouched */
  }

  if (!config.playlistKey) return value;
  const sep = value.includes("?") ? "&" : "?";
  return `${value}${sep}key=${encodeURIComponent(config.playlistKey)}`;
}
