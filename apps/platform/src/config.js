export const config = {
  port: Number(process.env.PLATFORM_PORT || 8080),
  publicUrl: (process.env.PUBLIC_URL || "https://resolver.vpn4u.cc").replace(/\/$/, ""),
  dlhdProxyUrl: (process.env.DLHD_PROXY_URL || "").replace(/\/$/, ""),
  dlhdUrl: (process.env.DLHD_URL || "http://dlhd:3000").replace(/\/$/, ""),
  dlstreams247: process.env.DLSTREAMS_247 || "https://dlstreams.st/24-7-channels.php",
  dlstreamsHome: process.env.DLSTREAMS_HOME || "https://dlstreams.st/",
  liveDir: process.env.PATH_LIVE || "/mnt/resolver-files/Live",
  epgUrl: process.env.EPG_URL || "",
  liveRefreshMin: Math.max(1, Number(process.env.LIVE_REFRESH_MIN || 360)),
  adminPassword: process.env.ADMIN_PASSWORD || "",
  playlistKey: process.env.PLAYLIST_KEY || "",
};

export function withKey(url) {
  if (!config.playlistKey) return url;
  const sep = String(url).includes("?") ? "&" : "?";
  return `${url}${sep}key=${encodeURIComponent(config.playlistKey)}`;
}
