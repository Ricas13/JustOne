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
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { value, exp: Date.now() + TTL_MS });
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

function sourceQuality(s) {
  if (!s) return "";
  if (typeof s === "string") return "";
  const raw = String(s.quality || s.resolution || s.height || "").toLowerCase();
  if (/2160|4k|uhd|3840/.test(raw) || raw === "2160p") return "4k";
  if (/1080/.test(raw)) return "1080p";
  if (/720/.test(raw)) return "720p";
  if (/480|360|240/.test(raw)) return raw;
  const t = JSON.stringify(s).toLowerCase();
  if (/2160|4k|uhd|3840/.test(t)) return "4k";
  if (/1080/.test(t)) return "1080p";
  if (/720/.test(t)) return "720p";
  return raw || "unknown";
}

function qualityRank(q, want) {
  if (want === "4k") return q === "4k" ? 3 : 0;
  if (q === "1080p") return 3;
  if (q === "720p") return 2;
  if (q === "4k") return 0;
  return 1;
}

export function pickSource(sources, quality) {
  const list = (sources || []).map((s) => ({
    url: sourceUrl(s) ? publicizeStreamUrl(sourceUrl(s)) : null,
    quality: sourceQuality(s),
    provider: s?.provider?.id || s?.provider || "",
    raw: s,
  })).filter((s) => s.url);
  const available = [...new Set(list.map((s) => s.quality))];
  const ranked = [...list].sort((a, b) => qualityRank(b.quality, quality) - qualityRank(a.quality, quality));
  const exact = ranked.find((s) => qualityRank(s.quality, quality) === 3);
  const fallback = quality === "4k" ? null : ranked[0];
  const best = exact || fallback;
  return {
    url: best?.url || null,
    quality: best?.quality || null,
    provider: best?.provider || null,
    type: best?.raw?.type || "",
    available,
    wanted: quality,
    matched: Boolean(exact),
  };
}

async function cineproMovie(tmdbId) {
  const r = await fetch(`${config.cineproUrl}/v1/movies/${tmdbId}`, {
    signal: AbortSignal.timeout(90000),
  });
  return r.json();
}

async function cineproEpisode(tmdbId, season, episode) {
  const r = await fetch(
    `${config.cineproUrl}/v1/tv/${tmdbId}/seasons/${season}/episodes/${episode}`,
    { signal: AbortSignal.timeout(90000) },
  );
  return r.json();
}

export async function resolveMovie(tmdbId, quality = "1080p") {
  const key = `movie:${tmdbId}:${quality}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const data = await cineproMovie(tmdbId);
  const picked = pickSource(extractSources(data), quality);
  picked.diagnostics = (data?.diagnostics || []).slice(0, 8);
  if (picked.url) cacheSet(key, picked);
  return picked;
}

export async function resolveEpisode(tmdbId, season, episode, quality = "1080p") {
  const key = `ep:${tmdbId}:${season}:${episode}:${quality}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const data = await cineproEpisode(tmdbId, season, episode);
  const picked = pickSource(extractSources(data), quality);
  picked.diagnostics = (data?.diagnostics || []).slice(0, 8);
  if (picked.url) cacheSet(key, picked);
  return picked;
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
  const url = loc && /^https?:/i.test(loc) ? loc : `${config.dlhdUrl}/api/stream/${channelId}.m3u8`;
  const picked = { url, quality: "live", available: ["live"], wanted: "live", matched: true };
  cacheSet(key, picked);
  return picked;
}

export function cacheStats() {
  return { size: cache.size };
}
