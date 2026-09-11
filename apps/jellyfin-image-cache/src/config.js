function numberEnv(name, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

export const config = {
  port: numberEnv("JELLYFIN_IMAGE_CACHE_PORT", 8091, 1, 65535),
  upstreamUrl: (process.env.JELLYFIN_IMAGE_CACHE_UPSTREAM_URL || "http://jellyfin-live:8090").replace(/\/$/, ""),
  publicUrl: (process.env.PUBLIC_URL || "http://resolver:8080").replace(/\/$/, ""),
  playlistKey: process.env.PLAYLIST_KEY || "",
  cacheDir: process.env.JELLYFIN_IMAGE_CACHE_DIR || "/var/cache/justone-images",
  ttlMs: numberEnv("JELLYFIN_IMAGE_CACHE_TTL_MS", 30 * 24 * 60 * 60 * 1000, 60_000),
  negativeTtlMs: numberEnv("JELLYFIN_IMAGE_CACHE_NEGATIVE_TTL_MS", 6 * 60 * 60 * 1000, 60_000),
  fetchTimeoutMs: numberEnv("JELLYFIN_IMAGE_CACHE_FETCH_TIMEOUT_MS", 10_000, 1_000),
  fetchConcurrency: numberEnv("JELLYFIN_IMAGE_CACHE_FETCH_CONCURRENCY", 4, 1, 16),
  maxBytes: numberEnv("JELLYFIN_IMAGE_CACHE_MAX_BYTES", 8 * 1024 * 1024, 64 * 1024),
  missWaitMs: numberEnv("JELLYFIN_IMAGE_CACHE_MISS_WAIT_MS", 250, 0, 5_000),
  hostBackoffMs: numberEnv("JELLYFIN_IMAGE_CACHE_HOST_BACKOFF_MS", 15 * 60 * 1000, 10_000),
};

export function withKey(url) {
  if (!config.playlistKey) return url;
  const out = new URL(url);
  out.searchParams.set("key", config.playlistKey);
  return out.href;
}
