export const config = {
  port: Number(process.env.PLATFORM_PORT || 8080),
  publicUrl: (process.env.PUBLIC_URL || "http://localhost:8080").replace(/\/$/, ""),
  cineproUrl: (process.env.CINEPRO_URL || "http://localhost:3000").replace(/\/$/, ""),
  cineproPublicUrl: (process.env.CINEPRO_PUBLIC_URL || process.env.PUBLIC_URL || "http://localhost:3000")
    .replace(/\/$/, ""),
  dlhdUrl: (process.env.DLHD_URL || "http://localhost:3001").replace(/\/$/, ""),
  libraryRoot: process.env.LIBRARY_ROOT || "./data/library",
  epgUrl: process.env.EPG_URL || "",
  tmdbKey: process.env.TMDB_API_KEY || "",
  liveRefreshMin: Number(process.env.LIVE_REFRESH_MIN || 30),
  qualities: String(process.env.QUALITIES || "1080p,4k")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  logLevel: process.env.LOG_LEVEL || "info",
};

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
