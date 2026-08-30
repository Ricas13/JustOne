import { config, publicizeStreamUrl } from "./config.js";
import { rememberSourceHeaders } from "./services/sourceHeaders.js";
import { fetchMovieStreams, fetchEpisodeStreams } from "./services/webStreamrClient.js";

const cache = new Map();
const TTL_MS = Number(process.env.RESOLVE_TTL_MS || 60 * 60 * 1000);
const PROBE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) JustOne source resolver";
const PROBE_BATCH_SIZE = 3;
const PLAYBACK_SOURCE_PROBE_TIMEOUT_MS = Math.max(
  500,
  Number(process.env.PLAYBACK_SOURCE_PROBE_TIMEOUT_MS || 5000),
);
const PLAYBACK_SOURCE_FAILURE_COOLDOWN_MS = Math.max(
  1000,
  Number(process.env.PLAYBACK_SOURCE_FAILURE_COOLDOWN_MS || 5 * 60 * 1000),
);
const PLAYBACK_SOURCE_FAILOVER_ATTEMPTS = Math.max(
  1,
  Math.min(10, Number(process.env.PLAYBACK_SOURCE_FAILOVER_ATTEMPTS || 4)),
);
const PLAYBACK_SOURCE_RECHECK_MS = Math.max(
  0,
  Number(process.env.PLAYBACK_SOURCE_RECHECK_MS || 15000),
);
const suppressedSources = new Map();

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

function pruneSuppressedSources(now = Date.now()) {
  for (const [url, exp] of suppressedSources) {
    if (exp <= now) suppressedSources.delete(url);
  }
}

function sourceSuppressed(url, now = Date.now()) {
  if (!url) return false;
  const key = String(url);
  const exp = suppressedSources.get(key);
  if (!exp) return false;
  if (exp <= now) {
    suppressedSources.delete(key);
    return false;
  }
  return true;
}

export function suppressSource(url, ttlMs = PLAYBACK_SOURCE_FAILURE_COOLDOWN_MS) {
  if (!url) return false;
  const key = String(url);
  const exp = Date.now() + Math.max(1000, Number(ttlMs || PLAYBACK_SOURCE_FAILURE_COOLDOWN_MS));
  suppressedSources.set(key, exp);

  // A failed playback candidate must not survive in the normal one-hour resolver
  // cache. Remove every cached selection that points at it so concurrent/new
  // playback requests converge on an alternative immediately.
  for (const [cacheKey, hit] of cache) {
    if (hit?.value?.url === key) cache.delete(cacheKey);
  }
  return true;
}

export function clearSuppressedSources() {
  suppressedSources.clear();
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
    probeUrl: candidate?.probeUrl || null,
    quality: candidate?.quality || null,
    provider: candidate?.provider || null,
    resolver: candidate?.resolver || null,
    requestHeaders: candidate?.requestHeaders || {},
    type: candidate?.raw?.type || "",
    available,
    wanted: quality,
    matched,
    validated,
    validatedAt: validated ? Date.now() : null,
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

async function probeRequest(
  candidate,
  method,
  deadline,
  timeoutLimitMs = config.sourceProbeTimeoutMs,
) {
  const remaining = remainingMs(deadline);
  if (!remaining) return false;
  const timeout = Math.min(Math.max(500, Number(timeoutLimitMs)), remaining);
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

// Playback cannot trust a HEAD success: hosts such as Google Drive can answer
// metadata requests while refusing the actual file because a download quota or
// signed URL has expired. A one-byte ranged GET proves that media bytes are
// currently obtainable without carrying the media stream through JustOne.
export async function validateCandidateForPlayback(
  candidate,
  deadline = Date.now() + PLAYBACK_SOURCE_PROBE_TIMEOUT_MS,
) {
  if (!candidate?.probeUrl) return false;
  return probeRequest(candidate, "GET", deadline, PLAYBACK_SOURCE_PROBE_TIMEOUT_MS);
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

function runSecondaryCall(call, background) {
  return background ? Promise.resolve().then(call) : runProviderCall(call);
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

async function resolveVod({
  key,
  quality,
  primaryCall,
  secondaryCall,
  background = false,
  force = false,
}) {
  if (!force) {
    const cached = cacheGet(key);
    if (cached && (background || !sourceSuppressed(cached.url))) return cached;
  }

  const deadline = Date.now() + config.sourceResolveTimeoutMs;
  const [primaryResult, secondaryResult] = await Promise.allSettled([
    runProviderCall(primaryCall),
    runSecondaryCall(secondaryCall, background),
  ]);

  const primaryData = primaryResult.status === "fulfilled" ? primaryResult.value : null;
  const primarySources = extractSources(primaryData);
  const secondarySources = secondaryResult.status === "fulfilled" ? secondaryResult.value : [];
  const candidates = mergeCandidates(primarySources, secondarySources, quality);
  const selectableCandidates = background
    ? candidates
    : candidates.filter((candidate) => !sourceSuppressed(candidate.url));
  const working = await chooseWorkingCandidate(selectableCandidates, quality, deadline);

  let picked = resultFromCandidate(working, candidates, quality, { validated: Boolean(working) });

  if (!picked.url && primarySources.length && allowQualityFallback(quality)) {
    const primaryCandidates = selectableCandidates.filter((candidate) => candidate.resolver === "primary");
    const exact = primaryCandidates.find((candidate) => qualityRank(candidate.quality, quality) === 3);
    const fallback = primaryCandidates[0] || null;
    picked = resultFromCandidate(exact || fallback, candidates, quality, { validated: false });
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

async function resolveForPlayback(resolveCall) {
  let picked = await resolveCall(false);
  let failedCandidates = 0;

  for (let attempt = 0; attempt < PLAYBACK_SOURCE_FAILOVER_ATTEMPTS; attempt += 1) {
    if (!picked?.url) break;

    const recentlyChecked =
      picked.playbackValidatedAt &&
      Date.now() - picked.playbackValidatedAt <= PLAYBACK_SOURCE_RECHECK_MS;
    if (recentlyChecked) {
      picked.playbackValidated = true;
      picked.failoverAttempts = failedCandidates;
      return picked;
    }

    const ok = await validateCandidateForPlayback(
      picked,
      Date.now() + PLAYBACK_SOURCE_PROBE_TIMEOUT_MS,
    );
    if (ok) {
      picked.playbackValidated = true;
      picked.playbackValidatedAt = Date.now();
      picked.failoverAttempts = failedCandidates;
      return picked;
    }

    suppressSource(picked.url);
    failedCandidates += 1;
    if (attempt + 1 < PLAYBACK_SOURCE_FAILOVER_ATTEMPTS) {
      picked = await resolveCall(true);
    }
  }

  if (!picked) return picked;
  return {
    ...picked,
    url: null,
    probeUrl: null,
    quality: null,
    provider: null,
    resolver: null,
    matched: false,
    validated: false,
    playbackValidated: false,
    failoverAttempts: failedCandidates,
    playbackFailure: failedCandidates ? "sources-failed-byte-probe" : null,
  };
}

async function inspectVodAvailability({
  primaryCall,
  secondaryCall,
  strict = false,
  background = false,
}) {
  const [primaryResult, secondaryResult] = await Promise.allSettled([
    runProviderCall(primaryCall),
    runSecondaryCall(secondaryCall, background),
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
    background: true,
    primaryCall: () => healthCineproMovie(tmdbId),
    secondaryCall: () => fetchMovieStreams(tmdbId, { background: true }),
  });
}

export function checkEpisodeAvailability(tmdbId, season, episode, { strict = false } = {}) {
  return inspectVodAvailability({
    strict,
    background: true,
    primaryCall: () => healthCineproEpisode(tmdbId, season, episode),
    secondaryCall: () => fetchEpisodeStreams(tmdbId, season, episode, { background: true }),
  });
}

function resolveMovieOnce(tmdbId, quality, { background = false, force = false } = {}) {
  return resolveVod({
    key: `movie:${tmdbId}:${quality}`,
    quality,
    background,
    force,
    primaryCall: () => cineproMovie(tmdbId),
    secondaryCall: () => fetchMovieStreams(tmdbId, { background }),
  });
}

export function resolveMovie(
  tmdbId,
  quality = "1080p",
  { background = false, force = false, playbackCheck = !background } = {},
) {
  if (!background && playbackCheck) {
    return resolveForPlayback((retryForce) =>
      resolveMovieOnce(tmdbId, quality, { background: false, force: force || retryForce }),
    );
  }
  return resolveMovieOnce(tmdbId, quality, { background, force });
}

export function resolveMovieForPlayback(tmdbId, quality = "1080p") {
  return resolveMovie(tmdbId, quality, { playbackCheck: true });
}

function resolveEpisodeOnce(
  tmdbId,
  season,
  episode,
  quality,
  { background = false, force = false } = {},
) {
  return resolveVod({
    key: `ep:${tmdbId}:${season}:${episode}:${quality}`,
    quality,
    background,
    force,
    primaryCall: () => cineproEpisode(tmdbId, season, episode),
    secondaryCall: () => fetchEpisodeStreams(tmdbId, season, episode, { background }),
  });
}

export function resolveEpisode(
  tmdbId,
  season,
  episode,
  quality = "1080p",
  { background = false, force = false, playbackCheck = !background } = {},
) {
  if (!background && playbackCheck) {
    return resolveForPlayback((retryForce) =>
      resolveEpisodeOnce(tmdbId, season, episode, quality, {
        background: false,
        force: force || retryForce,
      }),
    );
  }
  return resolveEpisodeOnce(tmdbId, season, episode, quality, { background, force });
}

export function resolveEpisodeForPlayback(tmdbId, season, episode, quality = "1080p") {
  return resolveEpisode(tmdbId, season, episode, quality, { playbackCheck: true });
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
  pruneSuppressedSources();
  return {
    size: cache.size,
    ttlMs: TTL_MS,
    suppressedSources: suppressedSources.size,
    playbackSourceFailureCooldownMs: PLAYBACK_SOURCE_FAILURE_COOLDOWN_MS,
    playbackSourceFailoverAttempts: PLAYBACK_SOURCE_FAILOVER_ATTEMPTS,
    playbackSourceRecheckMs: PLAYBACK_SOURCE_RECHECK_MS,
  };
}
