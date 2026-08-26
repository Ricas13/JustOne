export const config = {
  port: Number(process.env.PLATFORM_PORT || 8080),
  publicUrl: (process.env.PUBLIC_URL || "http://localhost:8080").replace(/\/$/, ""),
  cineproUrl: (process.env.CINEPRO_URL || "http://localhost:3000").replace(/\/$/, ""),
  dlhdUrl: (process.env.DLHD_URL || "http://localhost:3001").replace(/\/$/, ""),
  moviesPath: process.env.MOVIES_PATH || "./data/library/movies",
  tvPath: process.env.TV_PATH || "./data/library/tv",
  livePath: process.env.LIVE_PATH || "./data/library/live",
  strmUseProxy: String(process.env.STRM_USE_PROXY || "true") === "true",
  logLevel: process.env.LOG_LEVEL || "info",
};
