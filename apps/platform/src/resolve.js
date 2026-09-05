import { config } from "./config.js";

const cache = new Map();
const inFlight = new Map();
let coalescedJoins = 0;
const TTL_MS = Math.max(1000, Number(process.env.RESOLVE_TTL_MS || 60 * 60 * 1000));
const LIVE_SOURCE_PROBE_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.LIVE_SOURCE_PROBE_TIMEOUT_MS || 2500),
);
const LIVE_SOURCE_RECHECK_MS = Math.max(
  0,
  Number(process.env.LIVE_SOURCE_RECHECK_MS || 5 * 60 * 1000),
);
const MANIFEST_PREFIX_MAX_BYTES = 128 * 1024;

class LiveEndpointError extends Error {
  constructor(message, { status = null, transport = false } = {}) {
    super(message);
    this.status = status;
    this.transport = transport;
  }
}

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
      primary: true,
    });
  }
  if (legacyUrl) {
    endpoints.push({
      provider: "legacy-dlhd-web",
      url: `${String(legacyUrl).replace(/\/$/, "")}/api/stream/${id}.m3u8`,
      primary: false,
    });
  }
  return endpoints;
}

async function readManifestPrefix(response) {
  if (!response?.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < MANIFEST_PREFIX_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      const remaining = MANIFEST_PREFIX_MAX_BYTES - total;
      const chunk = Buffer.from(value.subarray(0, remaining));
      chunks.push(chunk);
      total += chunk.length;
      if (value.length > remaining) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* best-effort cleanup */
    }
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

/**
 * Admit a resolver endpoint quickly. dlhd-proxy already walks/player-probes the
 * DaddyLive candidates, so the platform only verifies that the returned body
 * is actually HLS. Deep segment validation here used to add another 7+ second
 * tax before FFmpeg could even start.
 */
async function resolveLiveEndpoint(endpoint) {
  let response;
  try {
    response = await fetch(endpoint.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(LIVE_SOURCE_PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new LiveEndpointError(`${endpoint.provider} transport failed`, {
      transport: true,
    });
  }

  if (response.status < 200 || response.status >= 300) {
    try {
      await response.body?.cancel();
    } catch {
      /* best-effort cleanup */
    }
    throw new LiveEndpointError(`${endpoint.provider} returned ${response.status}`, {
      status: response.status,
    });
  }

  const text = await readManifestPrefix(response);
  if (!text.trimStart().startsWith("#EXTM3U")) {
    throw new LiveEndpointError(`${endpoint.provider} returned no HLS manifest`, {
      status: response.status,
    });
  }

  return endpoint.url;
}

function shouldTryLegacyAfterPrimary(error) {
  // A primary 404 means the resolver completed its player-family walk and found
  // no usable source for this id. Running the legacy resolver immediately would
  // just double cold-tune latency. Transport errors and 5xx can still use the
  // legacy backend as the operational fallback.
  return Boolean(error?.transport || (Number(error?.status) >= 500 && Number(error?.status) <= 599));
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
      const recent =
        cached.liveValidatedAt &&
        Date.now() - cached.liveValidatedAt <= LIVE_SOURCE_RECHECK_MS;
      if (recent) return cached;
      // Do not synchronously deep-probe an established cache entry on a click.
      // FFmpeg/renewal is the authoritative liveness signal; its supervised
      // failure path re-enters resolveLive with refresh=1.
      cached.liveValidatedAt = Date.now();
      return cached;
    }
  }

  const endpoints = liveStreamEndpoints(channelId, { proxyUrl, legacyUrl });
  let lastError = null;
  for (let index = 0; index < endpoints.length; index += 1) {
    const endpoint = endpoints[index];
    try {
      const url = await resolveLiveEndpoint(endpoint);
      const picked = {
        url,
        quality: "live",
        available: ["live"],
        wanted: "live",
        matched: true,
        validated: true,
        playbackValidated: false,
        liveValidated: true,
        liveValidatedAt: Date.now(),
        provider: endpoint.provider,
      };
      cacheSet(key, picked);
      return picked;
    } catch (error) {
      lastError = error;
      if (endpoint.primary && !shouldTryLegacyAfterPrimary(error)) break;
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
