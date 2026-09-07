import { config } from "./config.js";

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
 * The pinned amddeus backend currently converts every StepDaddy ValueError to
 * HTTP 404. That includes genuinely missing channels, but also transient
 * "direct HLS playlist Timeout" / "player budget exhausted" failures. A single
 * 404 therefore cannot be treated as authoritative. Retry it briefly before
 * falling back to the independent legacy resolver.
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

function shouldTryLegacyAfterPrimary(error) {
  const status = Number(error?.status);
  // amddeus-dlhd-proxy currently collapses transient player timeouts into 404,
  // so an exhausted primary 404 is eligible for the independent legacy path.
  if (status === 404 && error?.provider === "amddeus-dlhd-proxy") return true;
  return Boolean(
    error?.transport ||
      error?.invalid ||
      (status >= 500 && status <= 599),
  );
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
      const url =
        index === 0 && endpoint.provider === "amddeus-dlhd-proxy"
          ? await resolvePrimaryWith404Recovery(endpoint)
          : await resolveLiveEndpoint(endpoint);
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
      if (index === 0 && endpoints.length > 1 && !shouldTryLegacyAfterPrimary(error)) break;
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
    primary404Retries: LIVE_PRIMARY_404_RETRIES,
    primary404RetryDelayMs: LIVE_PRIMARY_404_RETRY_DELAY_MS,
    inFlight: inFlight.size,
    coalescedJoins,
  };
}
