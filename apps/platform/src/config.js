export const config = {
  port: Number(process.env.PLATFORM_PORT || 8080),
  publicUrl: (process.env.PUBLIC_URL || "https://resolver.vpn4u.cc").replace(/\/$/, ""),
  cineproUrl: (process.env.CINEPRO_URL || "http://cinepro:3000").replace(/\/$/, ""),
  cineproPublicUrl: (process.env.CINEPRO_PUBLIC_URL || "https://resolver.vpn4u.cc/cinepro").replace(
    /\/$/,
    "",
  ),
  dlhdUrl: (process.env.DLHD_URL || "http://dlhd:3000").replace(/\/$/, ""),
  dlstreams247: process.env.DLSTREAMS_247 || "https://dlstreams.st/24-7-channels.php",
  movies1080: process.env.PATH_MOVIES_1080 || "/mnt/resolver-files/Movies/Movies",
  movies4k: process.env.PATH_MOVIES_4K || "/mnt/resolver-files/Movies/Movies-4K",
  tv1080: process.env.PATH_TV_1080 || "/mnt/resolver-files/TV/TV",
  tv4k: process.env.PATH_TV_4K || "/mnt/resolver-files/TV/TV-4K",
  liveDir: process.env.PATH_LIVE || "/mnt/resolver-files/Live",
  epgUrl: process.env.EPG_URL || "",
  tmdbKey: process.env.TMDB_API_KEY || "",
  liveRefreshMin: Number(process.env.LIVE_REFRESH_MIN || 30),
  generateOnStart: String(process.env.GENERATE_ON_START || "true") !== "false",
  moviePages: Number(process.env.MOVIE_PAGES || 25),
  tvPages: Number(process.env.TV_PAGES || 15),
  tvMaxEpisodes: Number(process.env.TV_MAX_EPISODES || 24),
  qualities: String(process.env.QUALITIES || "1080p,4k")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  logLevel: process.env.LOG_LEVEL || "info",
  adminPassword: process.env.ADMIN_PASSWORD || "",
};

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
