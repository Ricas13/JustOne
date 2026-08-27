import { config, publicizeStreamUrl } from "./config.js";

const cache = new Map();
const TTL_MS = Number(process.env.RESOLVE_TTL_MS || 15 * 60 * 1000);

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    cache.delete(key);
    return null;
  }
  return hit.url;
}

function cacheSet(key, url) {
  cache.set(key, { url, exp: Date.now() + TTL_MS });
}

function extractSources(data) {
  if (!data) return [];
  if (Array.isArray(data.sources)) return data.sources;
  if (Array.isArray(data.streams)) return data.streams;
  if (Array.isArray(data.results)) return data.results;
  if (Array.isArray(data)) return data;
  return [];
}

function sourceUrl(s) {
  if (!s) return null;
  if (typeof s === "string") return s;
  return s.url || s.src || s.stream || s.file || null;
}

function qualityScore(source, want) {
  const t = JSON.stringify(source).toLowerCase();
  if (want === "4k") {
    if (/2160|4k|uhd|3840/.test(t)) return 2;
    return 0;
  }
  if (/2160|4k|uhd/.test(t)) return 0;
  if (/1080/.test(t)) return 2;
  if (/720/.test(t)) return 1;
  return 0;
}

export function pickSource(sources, quality) {
  if (!sources?.length) return null;
  const ranked = [...sources].sort(
    (a, b) => qualityScore(b, quality) - qualityScore(a, quality),
  );
  const best = ranked.find((s) => qualityScore(s, quality) > 0) || ranked[0];
  const url = sourceUrl(best);
  return url ? publicizeStreamUrl(url) : null;
}

export async function resolveMovie(tmdbId, quality = "1080p") {
  const key = `movie:${tmdbId}:${quality}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const r = await fetch(`${config.cineproUrl}/v1/movies/${tmdbId}`, {
    signal: AbortSignal.timeout(90000),
  });
  const data = await r.json();
  const url = pickSource(extractSources(data), quality);
  if (url) cacheSet(key, url);
  return url;
}

export async function resolveEpisode(tmdbId, season, episode, quality = "1080p") {
  const key = `ep:${tmdbId}:${season}:${episode}:${quality}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const r = await fetch(
    `${config.cineproUrl}/v1/tv/${tmdbId}/seasons/${season}/episodes/${episode}`,
    { signal: AbortSignal.timeout(90000) },
  );
  const data = await r.json();
  const url = pickSource(extractSources(data), quality);
  if (url) cacheSet(key, url);
  return url;
}

export async function resolveLive(channelId, { force = false } = {}) {
  const key = `live:${channelId}`;
  if (!force) {
    const cached = cacheGet(key);
    if (cached) return cached;
  }
  const r = await fetch(`${config.dlhdUrl}/api/stream/${channelId}.m3u8`, {
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  });
  const loc = r.headers.get("location");
  if (loc && /^https?:/i.test(loc)) {
    cacheSet(key, loc);
    return loc;
  }
  const fallback = `${config.dlhdUrl}/api/stream/${channelId}.m3u8`;
  cacheSet(key, fallback);
  return fallback;
}

export function cacheStats() {
  return { size: cache.size };
}
