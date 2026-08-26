export const config = {
  port: Number(process.env.PLATFORM_PORT || 8080),
  publicUrl: (process.env.PUBLIC_URL || "http://localhost:8080").replace(/\/$/, ""),
  cineproUrl: (process.env.CINEPRO_URL || "http://localhost:3000").replace(/\/$/, ""),
  cineproPublicUrl: (process.env.CINEPRO_PUBLIC_URL || process.env.PUBLIC_URL || "http://localhost:3010")
    .replace(/\/$/, ""),
  dlhdUrl: (process.env.DLHD_URL || "http://localhost:3001").replace(/\/$/, ""),
  moviesPath: process.env.MOVIES_PATH || "./data/library/movies",
  tvPath: process.env.TV_PATH || "./data/library/tv",
  livePath: process.env.LIVE_PATH || "./data/library/live",
  strmUseProxy: String(process.env.STRM_USE_PROXY || "true") === "true",
  logLevel: process.env.LOG_LEVEL || "info",
};

/** Rewrite internal CinePro URLs to the public Traefik URL */
export function publicizeStreamUrl(url) {
  if (!url || typeof url !== "string") return url;
  let out = url;
  const replacements = [
    ["http://localhost:3000", config.cineproPublicUrl],
    ["http://127.0.0.1:3000", config.cineproPublicUrl],
    ["http://cinepro:3000", config.cineproPublicUrl],
    ["http://localhost:3010", config.cineproPublicUrl],
  ];
  for (const [from, to] of replacements) {
    if (out.includes(from)) out = out.split(from).join(to);
  }
  return out;
}
