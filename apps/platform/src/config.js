export const config = {
  port: Number(process.env.PLATFORM_PORT || 8080),
  publicUrl: (process.env.PUBLIC_URL || "https://resolver.vpn4u.cc").replace(/\/$/, ""),
  cineproUrl: (process.env.CINEPRO_URL || "http://cinepro:3000").replace(/\/$/, ""),
  cineproPublicUrl: (process.env.CINEPRO_PUBLIC_URL || "https://resolver.vpn4u.cc/cinepro").replace(
    /\/$/,
    "",
  ),
  streamProviderUrl: (process.env.WEBSTREAMR_MBG_URL || "http://webstreamr-mbg:51546").replace(
    /\/$/,
    "",
  ),
  sourceProviderTimeoutMs: Math.max(500, Number(process.env.SOURCE_PROVIDER_TIMEOUT_MS || 5000)),
  sourceResolveTimeoutMs: Math.max(1000, Number(process.env.SOURCE_RESOLVE_TIMEOUT_MS || 15000)),
  sourceProbeTimeoutMs: Math.max(500, Number(process.env.SOURCE_PROBE_TIMEOUT_MS || 2500)),
  dlhdUrl: (process.env.DLHD_URL || "http://dlhd:3000").replace(/\/$/, ""),
  dlstreams247: process.env.DLSTREAMS_247 || "https://dlstreams.st/24-7-channels.php",
  dlstreamsHome: process.env.DLSTREAMS_HOME || "https://dlstreams.st/",
  movies1080: process.env.PATH_MOVIES_1080 || "/mnt/library-resolver/Movies/Movies",
  movies4k: process.env.PATH_MOVIES_4K || "/mnt/library-resolver/Movies/Movies-4K",
  tv1080: process.env.PATH_TV_1080 || "/mnt/library-resolver/TV/TV",
  tv4k: process.env.PATH_TV_4K || "/mnt/library-resolver/TV/TV-4K",
  liveDir: process.env.PATH_LIVE || "/mnt/resolver-files/Live",
  epgUrl: process.env.EPG_URL || "",
  tmdbKey: process.env.TMDB_API_KEY || "",
  liveRefreshMin: Number(process.env.LIVE_REFRESH_MIN || 360),
  catalogRefreshHours: Number(process.env.CATALOG_REFRESH_HOURS || 6),
  generateOnStart: String(process.env.GENERATE_ON_START || "true") !== "false",
  moviePages: Number(process.env.MOVIE_PAGES || 40),
  tvPages: Number(process.env.TV_PAGES || 25),
  tvMaxEpisodes: Number(process.env.TV_MAX_EPISODES || 24),
  tvMaxSeasons: Number(process.env.TV_MAX_SEASONS || 4),
  maxMovies: Number(process.env.MAX_MOVIES || 5000),
  maxShows: Number(process.env.MAX_SHOWS || 1500),
  strmIoDelayMs: Math.max(0, Number(process.env.STRM_IO_DELAY_MS || 20)),
  qualityFallback: String(process.env.QUALITY_FALLBACK || "true") !== "false",
  discoverFromYear: Number(process.env.DISCOVER_FROM_YEAR || 1980),
  qualities: String(process.env.QUALITIES || "1080p,4k")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  logLevel: process.env.LOG_LEVEL || "info",
  adminPassword: process.env.ADMIN_PASSWORD || "",
  playlistKey: process.env.PLAYLIST_KEY || "",
};

export function withKey(url) {
  if (!config.playlistKey) return url;
  const sep = String(url).includes("?") ? "&" : "?";
  return `${url}${sep}key=${encodeURIComponent(config.playlistKey)}`;
}

export function rootFor(kind, quality) {
  if (kind === "movie") return quality === "4k" ? config.movies4k : config.movies1080;
  return quality === "4k" ? config.tv4k : config.tv1080;
}

export function publicizeStreamUrl(url) {
  if (!url || typeof url !== "string") return url;
  let out = url;
  const replacements = [
    ["http://localhost:3000", config.cineproPublicUrl],
    ["http://127.0.0.1:3000", config.cineproPublicUrl],
    ["http://cinepro:3000", config.cineproPublicUrl],
  ];
  for (const [from, to] of replacements) {
    if (out.includes(from)) out = out.split(from).join(to);
  }
  return out;
}
