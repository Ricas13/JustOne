export const config = {
  port: Number(process.env.PLATFORM_PORT || 8080),
  publicUrl: (process.env.PUBLIC_URL || "https://resolver.vpn4u.cc").replace(/\/$/, ""),
  playbackUrl: (process.env.PLAYBACK_URL || process.env.PUBLIC_URL || "https://resolver.vpn4u.cc").replace(/\/$/, ""),
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
  let value = String(url);

  // Renewable HLS children must stay on the same origin as the manifest that
  // referenced them. The platform's FFmpeg enters /play/live through loopback;
  // returning an absolute PUBLIC_URL here would hairpin every HLS refresh out
  // through Traefik/TLS and back into this same container. External clients
  // likewise resolve the relative path against the public origin naturally.
  const renewablePrefix = `${config.publicUrl}/play/renew/`;
  if (value.startsWith(renewablePrefix)) {
    value = value.slice(config.publicUrl.length);
  }

  if (!config.playlistKey) return value;
  const sep = value.includes("?") ? "&" : "?";
  return `${value}${sep}key=${encodeURIComponent(config.playlistKey)}`;
}
