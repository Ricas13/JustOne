import { config } from "./config.js";
import { validatePlaybackMedia } from "./services/mediaProbe.js";

const cache = new Map();
const inFlight = new Map();
let coalescedJoins = 0;
const TTL_MS = Math.max(1000, Number(process.env.RESOLVE_TTL_MS || 60 * 60 * 1000));
const PROBE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) JustOne live resolver";
const LIVE_SOURCE_PROBE_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.LIVE_SOURCE_PROBE_TIMEOUT_MS || 7000),
);
const LIVE_SOURCE_RECHECK_MS = Math.max(
  0,
  Number(process.env.LIVE_SOURCE_RECHECK_MS || 15000),
);

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

function inFlightKey(channelId, { force, proxyUrl, legacyUrl }) {
  return JSON.stringify([
    String(channelId || ""),
    Boolean(force),
    String(proxyUrl || ""),
    String(legacyUrl || ""),
  ]);
}

export function liveStreamEndpoints(
  channelId,
  { proxyUrl = config.dlhdProxyUrl, legacyUrl = config.dlhdUrl } = {},
) {
  const id = encodeURIComponent(String(channelId || "").replace(/\.(?:m3u8|ts)$/i, ""));
  const endpoints = [];
  if (proxyUrl) {
    endpoints.push({
      provider: "amddeus-dlhd-proxy",
      url: `${String(proxyUrl).replace(/\/$/, "")}/stream/${id}.m3u8`,
    });
  }
  if (legacyUrl) {
    endpoints.push({
      provider: "legacy-dlhd-web",
      url: `${String(legacyUrl).replace(/\/$/, "")}/api/stream/${id}.m3u8`,
    });
  }
  return endpoints;
}

async function validateLiveMedia(url) {
  return validatePlaybackMedia(
    { url, probeUrl: url, requestHeaders: {} },
    Date.now() + LIVE_SOURCE_PROBE_TIMEOUT_MS,
    LIVE_SOURCE_PROBE_TIMEOUT_MS,
    PROBE_UA,
  );
}

async function resolveLiveEndpoint(endpoint) {
  // The media validator already performs the HTTP request, follows redirects,
  // walks HLS manifests and proves that a real segment returns bytes. Doing a
  // separate fetch here caused every fresh tune to resolve the same DLHD
  // channel once before validation and then again during validation.
  if (!(await validateLiveMedia(endpoint.url))) {
    throw new Error(`${endpoint.provider} returned no readable live media`);
  }
  return endpoint.url;
}

async function resolveLiveUncoalesced(
  channelId,
  {
    force,
    proxyUrl,
    legacyUrl,
  },
) {
  const key = `live:${channelId}`;
  if (!force) {
    const cached = cacheGet(key);
    if (cached) {
      const recentlyChecked =
        cached.liveValidatedAt &&
        Date.now() - cached.liveValidatedAt <= LIVE_SOURCE_RECHECK_MS;
      if (recentlyChecked) return cached;

      if (await validateLiveMedia(cached.url)) {
        cached.liveValidated = true;
        cached.liveValidatedAt = Date.now();
        return cached;
      }

      // A channel must not remain pinned to a stale one-hour cache entry when
      // its playlist still exists but its media segments have died.
      cache.delete(key);
    }
  }

  const endpoints = liveStreamEndpoints(channelId, { proxyUrl, legacyUrl });
  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const url = await resolveLiveEndpoint(endpoint);
      const picked = {
        url,
        quality: "live",
        available: ["live"],
        wanted: "live",
        matched: true,
        validated: true,
        playbackValidated: true,
        liveValidated: true,
        liveValidatedAt: Date.now(),
        provider: endpoint.provider,
      };
      cacheSet(key, picked);
      return picked;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("no DLHD live provider configured");
}

export async function resolveLive(
  channelId,
  {
    force = false,
    proxyUrl = config.dlhdProxyUrl,
    legacyUrl = config.dlhdUrl,
  } = {},
) {
  const options = { force, proxyUrl, legacyUrl };
  const operationKey = inFlightKey(channelId, options);
  const existing = inFlight.get(operationKey);
  if (existing) {
    coalescedJoins += 1;
    return existing;
  }

  const task = resolveLiveUncoalesced(channelId, options);
  inFlight.set(operationKey, task);
  try {
    return await task;
  } finally {
    if (inFlight.get(operationKey) === task) inFlight.delete(operationKey);
  }
}

export function cacheStats() {
  return {
    size: cache.size,
    ttlMs: TTL_MS,
    liveSourceProbeTimeoutMs: LIVE_SOURCE_PROBE_TIMEOUT_MS,
    liveSourceRecheckMs: LIVE_SOURCE_RECHECK_MS,
    inFlight: inFlight.size,
    coalescedJoins,
  };
}
