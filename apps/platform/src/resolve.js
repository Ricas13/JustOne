import { config } from "./config.js";
import {
  liveSourceManagerStats,
  preferredLiveSource,
  qualifyLiveSources,
  retainLiveSourceLearning as retainManagerLearning,
} from "./liveSourceManager.js";

const cache = new Map();
const inFlight = new Map();
let coalescedJoins = 0;
const TTL_MS = Math.max(1000, Number(process.env.RESOLVE_TTL_MS || 60 * 60 * 1000));
const LIVE_SOURCE_PROBE_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.LIVE_SOURCE_PROBE_TIMEOUT_MS || 3000),
);
const LIVE_SOURCE_RECHECK_MS = Math.max(
  0,
  Number(process.env.LIVE_SOURCE_RECHECK_MS || 5 * 60 * 1000),
);
const LIVE_PRIMARY_404_RETRIES = Math.max(
  0,
  Math.min(4, Number(process.env.LIVE_PRIMARY_404_RETRIES ?? 2)),
);
const LIVE_PRIMARY_404_RETRY_DELAY_MS = Math.max(
  100,
  Math.min(3000, Number(process.env.LIVE_PRIMARY_404_RETRY_DELAY_MS ?? 500)),
);
const MANIFEST_PREFIX_MAX_BYTES = 128 * 1024;

class LiveEndpointError extends Error {
  constructor(
    message,
    { status = null, transport = false, invalid = false, provider = "" } = {},
  ) {
    super(message);
    this.status = status;
    this.transport = transport;
    this.invalid = invalid;
    this.provider = provider;
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
 * Admit a resolver endpoint quickly. The platform verifies that each configured
 * candidate returns a real HLS manifest; candidates are qualified in parallel
 * by the live source manager rather than stopping at the first valid resolver.
 */
async function resolveLiveEndpoint(endpoint) {
  let response;
  try {
    response = await fetch(endpoint.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(LIVE_SOURCE_PROBE_TIMEOUT_MS),
    });
  } catch {
    throw new LiveEndpointError(`${endpoint.provider} transport failed`, {
      transport: true,
      provider: endpoint.provider,
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
      provider: endpoint.provider,
    });
  }

  const text = await readManifestPrefix(response);
  if (!text.trimStart().startsWith("#EXTM3U")) {
    throw new LiveEndpointError(`${endpoint.provider} returned no HLS manifest`, {
      status: response.status,
      invalid: true,
      provider: endpoint.provider,
    });
  }

  return endpoint.url;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The pinned amddeus backend converts every StepDaddy ValueError to HTTP 404,
 * including transient playlist timeout/player-budget failures. Keep the bounded
 * recovery from PR #93, but run it concurrently with the other candidates.
 */
async function resolvePrimaryWith404Recovery(endpoint) {
  let lastError = null;
  for (let attempt = 0; attempt <= LIVE_PRIMARY_404_RETRIES; attempt += 1) {
    try {
      return await resolveLiveEndpoint(endpoint);
    } catch (error) {
      lastError = error;
      const transient404 =
        endpoint.provider === "amddeus-dlhd-proxy" && Number(error?.status) === 404;
      if (!transient404 || attempt >= LIVE_PRIMARY_404_RETRIES) throw error;
      await sleep(LIVE_PRIMARY_404_RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastError || new Error("primary live resolver failed");
}

async function probeManagedEndpoint(endpoint) {
  if (endpoint?.provider === "amddeus-dlhd-proxy") {
    return resolvePrimaryWith404Recovery(endpoint);
  }
  return resolveLiveEndpoint(endpoint);
}

function pickedFromEndpoint(endpoint) {
  return {
    url: endpoint.url,
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
}

async function resolveLiveUncoalesced(channelId, { force, proxyUrl, legacyUrl }) {
  const key = `live:${channelId}`;
  const endpoints = liveStreamEndpoints(channelId, { proxyUrl, legacyUrl });
  if (!endpoints.length) throw new Error("no DLHD live provider configured");

  if (!force) {
    const preferred = preferredLiveSource(channelId, endpoints, probeManagedEndpoint, {
      maxAgeMs: LIVE_SOURCE_RECHECK_MS,
    });
    if (preferred) {
      const picked = pickedFromEndpoint(preferred);
      cacheSet(key, picked);
      return picked;
    }

    // Compatibility fallback for a cache created before a manager selection is
    // established. Once the manager has qualified candidates, its continuously
    // learned preference becomes authoritative.
    const cached = cacheGet(key);
    if (cached?.liveValidatedAt && Date.now() - cached.liveValidatedAt <= LIVE_SOURCE_RECHECK_MS) {
      return cached;
    }
  }

  const selected = await qualifyLiveSources(channelId, endpoints, probeManagedEndpoint, { force });
  const picked = pickedFromEndpoint(selected);
  cacheSet(key, picked);
  return picked;
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

/**
 * Keep every configured resolver candidate warm for the lifetime of an actual
 * Jellyfin tuner session. The manager probes candidates in parallel, learns
 * their stability/latency and maintains a ready standby without opening a
 * second full media stream.
 */
export function retainLiveSourceLearning(
  channelId,
  { proxyUrl = config.dlhdProxyUrl, legacyUrl = config.dlhdUrl } = {},
) {
  const endpoints = liveStreamEndpoints(channelId, { proxyUrl, legacyUrl });
  if (!endpoints.length) return () => {};
  return retainManagerLearning(channelId, endpoints, probeManagedEndpoint);
}

export function cacheStats() {
  return {
    size: cache.size,
    ttlMs: TTL_MS,
    liveSourceProbeTimeoutMs: LIVE_SOURCE_PROBE_TIMEOUT_MS,
    liveSourceRecheckMs: LIVE_SOURCE_RECHECK_MS,
    primary404Retries: LIVE_PRIMARY_404_RETRIES,
    primary404RetryDelayMs: LIVE_PRIMARY_404_RETRY_DELAY_MS,
    inFlight: inFlight.size,
    coalescedJoins,
    sourceManager: liveSourceManagerStats(),
  };
}
