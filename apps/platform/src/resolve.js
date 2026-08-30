import { config, publicizeStreamUrl } from "./config.js";
import { rememberSourceHeaders } from "./services/sourceHeaders.js";
import { fetchMovieStreams, fetchEpisodeStreams } from "./services/webStreamrClient.js";

const cache = new Map();
const TTL_MS = Number(process.env.RESOLVE_TTL_MS || 60 * 60 * 1000);
const PROBE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) JustOne source resolver";
const PROBE_BATCH_SIZE = 3;

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
  rememberSourceHeaders(value?.url, value?.requestHeaders, TTL_MS);
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

function sourceHeaders(s) {
  if (!s || typeof s === "string") return {};
  const raw = s.requestHeaders || s.behaviorHints?.proxyHeaders?.request;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw)
      .filter(([key, value]) => key && value != null)
      .map(([key, value]) => [String(key), String(value)]),
  );
}

function qualityRank(q, want) {
  if (want === "4k") return q === "4k" ? 3 : 0;
  if (q === "1080p") return 3;
  if (q === "720p") return 2;
  if (q === "4k") return 0;
  return 1;
}

function allowQualityFallback(quality) {
  return quality === "4k" ? config.quality4kFallback : config.qualityFallback;
}

function resolverRank(candidate) {
  return candidate.resolver === "primary" ? 2 : 1;
}

function primaryProbeUrl(url) {
  let out = String(url || "");
  for (const from of [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    config.cineproPublicUrl,
  ]) {
    if (out.includes(from)) out = out.split(from).join(config.cineproUrl);
  }
  return out;
}

function normalizeCandidate(s, resolver) {
  const rawUrl = sourceUrl(s);
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return null;
  return {
    url: publicizeStreamUrl(rawUrl),
    probeUrl: resolver === "primary" ? primaryProbeUrl(rawUrl) : rawUrl,
    quality: sourceQuality(s),
    provider: s?.provider?.id || s?.provider || resolver,
    resolver,
    requestHeaders: sourceHeaders(s),
    raw: s,
  };
}

export function mergeCandidates(primarySources, secondarySources, quality) {
  const rows = [
    ...(primarySources || []).map((s) => normalizeCandidate(s, "primary")),
    ...(secondarySources || []).map((s) => normalizeCandidate(s, "secondary")),
  ].filter(Boolean);

  const deduped = [];
  const byUrl = new Map();
  for (const row of rows) {
    const existing = byUrl.get(row.url);
    if (existing) {
      existing.requestHeaders = { ...row.requestHeaders, ...existing.requestHeaders };
      continue;
    }
    byUrl.set(row.url, row);
    deduped.push(row);
  }

  return deduped.sort((a, b) => {
    const qualityDiff = qualityRank(b.quality, quality) - qualityRank(a.quality, quality);
    if (qualityDiff) return qualityDiff;
    return resolverRank(b) - resolverRank(a);
  });
}

function resultFromCandidate(candidate, candidates, quality, { validated = false } = {}) {
  const available = [...new Set((candidates || []).map((s) => s.quality))];
  const matched = Boolean(candidate && qualityRank(candidate.quality, quality) === 3);
  return {
    url: candidate?.url || null,
    quality: candidate?.quality || null,
    provider: candidate?.provider || null,
    resolver: candidate?.resolver || null,
    requestHeaders: candidate?.requestHeaders || {},
    type: candidate?.raw?.type || "",
    available,
    wanted: quality,
    matched,
    validated,
  };
}

export function pickSource(sources, quality) {
  const candidates = mergeCandidates(sources, [], quality);
  const exact = candidates.find((s) => qualityRank(s.quality, quality) === 3);
  const fallback = allowQualityFallback(quality) ? candidates[0] : null;
  return resultFromCandidate(exact || fallback, candidates, quality, { validated: false });
}

function remainingMs(deadline) {
  return Math.max(0, deadline - Date.now());
}

async function probeRequest(candidate, method, deadline) {
  const remaining = remainingMs(deadline);
  if (!remaining) return false;
  const timeout = Math.min(config.sourceProbeTimeoutMs, remaining);
  const headers = {
    "user-agent": PROBE_UA,
    accept: "*/*",
    ...candidate.requestHeaders,
  };
  if (method === "GET" && !headers.range && !headers.Range) headers.Range = "bytes=0-0";

  try {
    const response = await fetch(candidate.probeUrl, {
      method,
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(timeout),
    });
    const ok = response.status >= 200 && response.status < 400;
    try {
      await response.body?.cancel();
    } catch {
      /* ignore cleanup errors */
    }
    return ok;
  } catch {
    return false;
  }
}

export async function validateCandidate(candidate, deadline = Date.now() + config.sourceResolveTimeoutMs) {
  if (!candidate?.probeUrl) return false;
  if (await probeRequest(candidate, "HEAD", deadline)) return true;
  return probeRequest(candidate, "GET", deadline);
}

async function chooseWorkingCandidate(candidates, quality, deadline) {
  const eligible = (candidates || []).filter(
    (candidate) => allowQualityFallback(quality) || qualityRank(candidate.quality, quality) === 3,
  );

  for (let offset = 0; offset < eligible.length && remainingMs(deadline); offset += PROBE_BATCH_SIZE) {
    const batch = eligible.slice(offset, offset + PROBE_BATCH_SIZE);
    const results = await Promise.all(batch.map((candidate) => validateCandidate(candidate, deadline)));
    const firstWorking = results.findIndex(Boolean);
    if (firstWorking >= 0) return batch[firstWorking];
  }
  return null;
}

function runProviderCall(call) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("source resolver timed out")),
      config.sourceProviderTimeoutMs,
    );
    timer.unref?.();
    Promise.resolve()
      .then(call)
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

// Existing primary resolver integration is intentionally kept intact.
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

async function healthCineproRequest(pathname) {
  const response = await fetch(`${config.cineproUrl}${pathname}`, {
    signal: AbortSignal.timeout(config.sourceProviderTimeoutMs),
  });
  if (!response.ok) throw new Error(`primary resolver returned ${response.status}`);
  return response.json();
}

function healthCineproMovie(tmdbId) {
  return healthCineproRequest(`/v1/movies/${tmdbId}`);
}

function healthCineproEpisode(tmdbId, season, episode) {
  return healthCineproRequest(`/v1/tv/${tmdbId}/seasons/${season}/episodes/${episode}`);
}

async function resolveVod({ key, quality, primaryCall, secondaryCall }) {
  const cached = cacheGet(key);
  if (cached) return cached;

  const deadline = Date.now() + config.sourceResolveTimeoutMs;
  const [primaryResult, secondaryResult] = await Promise.allSettled([
    runProviderCall(primaryCall),
    runProviderCall(secondaryCall),
  ]);

  const primaryData = primaryResult.status === "fulfilled" ? primaryResult.value : null;
  const primarySources = extractSources(primaryData);
  const secondarySources = secondaryResult.status === "fulfilled" ? secondaryResult.value : [];
  const candidates = mergeCandidates(primarySources, secondarySources, quality);
  const working = await chooseWorkingCandidate(candidates, quality, deadline);

  let picked = resultFromCandidate(working, candidates, quality, { validated: Boolean(working) });

  // Keep the legacy primary-only fallback for ordinary playback, but never use
  // it to turn a strict 4K library item into a lower-resolution stream.
  if (!picked.url && primarySources.length && allowQualityFallback(quality)) {
    picked = pickSource(primarySources, quality);
    picked.resolver = picked.url ? "primary" : null;
    picked.validationFallback = Boolean(picked.url);
  }

  picked.diagnostics = (primaryData?.diagnostics || []).slice(0, 8);
  picked.providerErrors = {
    primary:
      primaryResult.status === "rejected"
        ? String(primaryResult.reason?.message || primaryResult.reason)
        : null,
    secondary:
      secondaryResult.status === "rejected"
        ? String(secondaryResult.reason?.message || secondaryResult.reason)
        : null,
  };

  if (picked.url) cacheSet(key, picked);
  return picked;
}

async function inspectVodAvailability({ primaryCall, secondaryCall, strict = false }) {
  const [primaryResult, secondaryResult] = await Promise.allSettled([
    runProviderCall(primaryCall),
    runProviderCall(secondaryCall),
  ]);

  if (primaryResult.status !== "fulfilled" || secondaryResult.status !== "fulfilled") {
    return {
      state: "indeterminate",
      reason: "provider-error",
      providerErrors: {
        primary:
          primaryResult.status === "rejected"
            ? String(primaryResult.reason?.message || primaryResult.reason)
            : null,
        secondary:
          secondaryResult.status === "rejected"
            ? String(secondaryResult.reason?.message || secondaryResult.reason)
            : null,
      },
    };
  }

  const primarySources = extractSources(primaryResult.value);
  const secondarySources = secondaryResult.value || [];
  const candidates = mergeCandidates(primarySources, secondarySources, "1080p");
  if (!candidates.length) {
    return { state: "unavailable", reason: "no-direct-sources", candidates: 0 };
  }

  if (!strict) {
    return { state: "available", reason: "source-advertised", candidates: candidates.length };
  }

  const deadline = Date.now() + config.sourceResolveTimeoutMs;
  const working = await chooseWorkingCandidate(candidates, "1080p", deadline);
  return working
    ? { state: "available", reason: "source-validated", candidates: candidates.length }
    : { state: "unavailable", reason: "sources-failed-validation", candidates: candidates.length };
}

export function checkMovieAvailability(tmdbId, { strict = false } = {}) {
  return inspectVodAvailability({
    strict,
    primaryCall: () => healthCineproMovie(tmdbId),
    secondaryCall: () => fetchMovieStreams(tmdbId),
  });
}

export function checkEpisodeAvailability(tmdbId, season, episode, { strict = false } = {}) {
  return inspectVodAvailability({
    strict,
    primaryCall: () => healthCineproEpisode(tmdbId, season, episode),
    secondaryCall: () => fetchEpisodeStreams(tmdbId, season, episode),
  });
}

export function resolveMovie(tmdbId, quality = "1080p") {
  return resolveVod({
    key: `movie:${tmdbId}:${quality}`,
    quality,
    primaryCall: () => cineproMovie(tmdbId),
    secondaryCall: () => fetchMovieStreams(tmdbId),
  });
}

export function resolveEpisode(tmdbId, season, episode, quality = "1080p") {
  return resolveVod({
    key: `ep:${tmdbId}:${season}:${episode}:${quality}`,
    quality,
    primaryCall: () => cineproEpisode(tmdbId, season, episode),
    secondaryCall: () => fetchEpisodeStreams(tmdbId, season, episode),
  });
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
  return { size: cache.size, ttlMs: TTL_MS };
}
