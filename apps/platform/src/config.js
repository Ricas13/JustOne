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
  libraryResolverRoot: process.env.LIBRARY_RESOLVER_ROOT || "/mnt/library-resolver",
  movies1080: process.env.PATH_MOVIES_1080 || "/mnt/library-resolver/Movies/Movies",
  movies4k: process.env.PATH_MOVIES_4K || "/mnt/library-resolver/Movies/Movies-4K",
  tv1080: process.env.PATH_TV_1080 || "/mnt/library-resolver/TV/TV",
  tv4k: process.env.PATH_TV_4K || "/mnt/library-resolver/TV/TV-4K",
  liveDir: process.env.PATH_LIVE || "/mnt/resolver-files/Live",
  catalogStateDir: process.env.CATALOG_STATE_DIR || "/mnt/resolver-files/catalog-state",
  catalogQuarantineRoot:
    process.env.CATALOG_QUARANTINE_ROOT || "/mnt/library-resolver/.quarantine",
  epgUrl: process.env.EPG_URL || "",
  tmdbKey: process.env.TMDB_API_KEY || "",
  liveRefreshMin: Number(process.env.LIVE_REFRESH_MIN || 360),
  catalogRefreshHours: Math.max(1, Number(process.env.CATALOG_REFRESH_HOURS || 24)),
  generateOnStart: String(process.env.GENERATE_ON_START || "true") !== "false",
  moviePages: Number(process.env.MOVIE_PAGES || 40),
  tvPages: Number(process.env.TV_PAGES || 25),
  tvMaxEpisodes: Math.max(0, Number(process.env.TV_MAX_EPISODES || 24)),
  tvMaxSeasons: Math.max(0, Number(process.env.TV_MAX_SEASONS || 4)),

  // A zero ceiling means the catalog keeps growing for as long as TMDB yields
  // previously unseen titles. The initial target creates a useful first library;
  // subsequent scheduled runs append only the configured number of new IDs.
  maxMovies: Math.max(0, Number(process.env.MAX_MOVIES || 0)),
  maxShows: Math.max(0, Number(process.env.MAX_SHOWS || 0)),
  initialMoviesTarget: Math.max(0, Number(process.env.INITIAL_MOVIES_TARGET || 10000)),
  initialShowsTarget: Math.max(0, Number(process.env.INITIAL_SHOWS_TARGET || 1500)),
  moviesAddPerRun: Math.max(0, Number(process.env.MOVIES_ADD_PER_RUN || 2000)),
  showsAddPerRun: Math.max(0, Number(process.env.SHOWS_ADD_PER_RUN || 100)),
  catalogFreshPages: Math.max(0, Math.min(20, Number(process.env.CATALOG_FRESH_PAGES || 3))),
  catalogMaxDiscoveryPagesPerRun: Math.max(
    1,
    Number(process.env.CATALOG_MAX_DISCOVERY_PAGES_PER_RUN || 650),
  ),
  catalogTmdbDelayMs: Math.max(0, Number(process.env.CATALOG_TMDB_DELAY_MS || 200)),

  // Availability pruning is deliberately conservative. Both source resolvers
  // must answer successfully before a missing-source strike can be recorded.
  catalogHealthEnabled: String(process.env.CATALOG_HEALTH_ENABLED || "true") !== "false",
  catalogHealthIntervalHours: Math.max(
    1,
    Number(process.env.CATALOG_HEALTH_INTERVAL_HOURS || 24),
  ),
  catalogHealthMoviesPerRun: Math.max(
    0,
    Number(process.env.CATALOG_HEALTH_MOVIES_PER_RUN || 1000),
  ),
  catalogHealthShowsPerRun: Math.max(
    0,
    Number(process.env.CATALOG_HEALTH_SHOWS_PER_RUN || 100),
  ),
  catalogHealthRetryFailuresPerRun: Math.max(
    0,
    Number(process.env.CATALOG_HEALTH_RETRY_FAILURES_PER_RUN || 250),
  ),
  catalogHealthQuarantinedPerRun: Math.max(
    0,
    Number(process.env.CATALOG_HEALTH_QUARANTINED_PER_RUN || 50),
  ),
  catalogHealthConcurrency: Math.max(
    1,
    Math.min(12, Number(process.env.CATALOG_HEALTH_CONCURRENCY || 4)),
  ),
  catalogHealthFailureThreshold: Math.max(
    2,
    Number(process.env.CATALOG_HEALTH_FAILURE_THRESHOLD || 3),
  ),
  catalogHealthFailureGapHours: Math.max(
    1,
    Number(process.env.CATALOG_HEALTH_FAILURE_GAP_HOURS || 24),
  ),
  catalogHealthQuarantineDays: Math.max(
    1,
    Number(process.env.CATALOG_HEALTH_QUARANTINE_DAYS || 7),
  ),
  catalogQuarantineRecheckDays: Math.max(
    1,
    Number(process.env.CATALOG_QUARANTINE_RECHECK_DAYS || 7),
  ),
  catalogHealthStrict: String(process.env.CATALOG_HEALTH_STRICT || "false") === "true",
  catalogHealthShowSamples: Math.max(
    1,
    Math.min(5, Number(process.env.CATALOG_HEALTH_SHOW_SAMPLES || 2)),
  ),

  strmIoDelayMs: Math.max(0, Number(process.env.STRM_IO_DELAY_MS || 20)),
  qualityFallback: String(process.env.QUALITY_FALLBACK || "true") !== "false",
  discoverFromYear: Math.max(1900, Number(process.env.DISCOVER_FROM_YEAR || 1900)),
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
