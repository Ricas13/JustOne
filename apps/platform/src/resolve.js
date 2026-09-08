import { config } from "./config.js";
import {
  liveSourceManagerStats,
  noteLiveSourceObservation,
  preferredLiveSource,
  qualifyLiveSources,
  retainLiveSourceLearning as retainManagerLearning,
} from "./liveSourceManager.js";

const cache = new Map();
const inFlight = new Map();
const learningSessions = new Map();
const failedSourceQuarantine = new Map();
const failoverRetryAfter = new Map();
let coalescedJoins = 0;
const TTL_MS = Math.max(1000, Number(process.env.RESOLVE_TTL_MS || 60 * 60 * 1000));
const LIVE_SOURCE_PROBE_TIMEOUT_MS = Math.max(1000, Number(process.env.LIVE_SOURCE_PROBE_TIMEOUT_MS || 3000));
const LIVE_SOURCE_RECHECK_MS = Math.max(0, Number(process.env.LIVE_SOURCE_RECHECK_MS || 5 * 60 * 1000));
const LIVE_PRIMARY_404_RETRIES = Math.max(0, Math.min(4, Number(process.env.LIVE_PRIMARY_404_RETRIES ?? 2)));
const LIVE_PRIMARY_404_RETRY_DELAY_MS = Math.max(100, Math.min(3000, Number(process.env.LIVE_PRIMARY_404_RETRY_DELAY_MS ?? 500)));
const LIVE_CANDIDATE_TRANSIENT_RETRIES = Math.max(0, Math.min(3, Number(process.env.LIVE_CANDIDATE_TRANSIENT_RETRIES ?? 1)));
const LIVE_CANDIDATE_RETRY_DELAY_MS = Math.max(100, Math.min(2000, Number(process.env.LIVE_CANDIDATE_RETRY_DELAY_MS ?? 250)));
const LIVE_SOURCE_FAILURE_QUARANTINE_MS = Math.max(5000, Math.min(5 * 60_000, Number(process.env.LIVE_SOURCE_FAILURE_QUARANTINE_MS || 30_000)));
const LIVE_FAILOVER_RETRY_BACKOFF_MS = Math.max(1000, Math.min(30_000, Number(process.env.LIVE_FAILOVER_RETRY_BACKOFF_MS || 3000)));
const LIVE_SOURCE_DISCOVERY_TIMEOUT_MS = Math.max(1000, Math.min(5000, Number(process.env.LIVE_SOURCE_DISCOVERY_TIMEOUT_MS || 2500)));
const LIVE_SOURCE_MAX_CANDIDATES = Math.max(2, Math.min(16, Number(process.env.LIVE_SOURCE_MAX_CANDIDATES || 8)));
const MANIFEST_PREFIX_MAX_BYTES = 128 * 1024;

class LiveEndpointError extends Error {
  constructor(message, { status = null, transport = false, invalid = false, provider = "" } = {}) {
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
  if (Date.now() > hit.exp) { cache.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value) { cache.set(key, { value, exp: Date.now() + TTL_MS }); }
function inFlightKey(channelId, { force, proxyUrl, legacyUrl, excludeUrl }) {
  return JSON.stringify([
    String(channelId || ""),
    Boolean(force),
    String(proxyUrl || ""),
    String(legacyUrl || ""),
    String(excludeUrl || ""),
  ]);
}
function sourceFailureKey(channelId, url) {
  return JSON.stringify([String(channelId || ""), String(url || "")]);
}
function quarantineLiveSource(channelId, url) {
  const value = String(url || "");
  if (!value) return;
  failedSourceQuarantine.set(sourceFailureKey(channelId, value), Date.now() + LIVE_SOURCE_FAILURE_QUARANTINE_MS);
}
function isSourceQuarantined(channelId, url, now = Date.now()) {
  const key = sourceFailureKey(channelId, url);
  const until = Number(failedSourceQuarantine.get(key) || 0);
  if (!until) return false;
  if (until <= now) {
    failedSourceQuarantine.delete(key);
    return false;
  }
  return true;
}
function failoverBackoffKey(channelId, excludeUrl) {
  return sourceFailureKey(channelId, excludeUrl);
}
function activeFailoverBackoff(channelId, excludeUrl) {
  const key = failoverBackoffKey(channelId, excludeUrl);
  const until = Number(failoverRetryAfter.get(key) || 0);
  if (!until) return 0;
  if (until <= Date.now()) {
    failoverRetryAfter.delete(key);
    return 0;
  }
  return until;
}
function markFailoverFailure(channelId, excludeUrl) {
  if (!excludeUrl) return;
  failoverRetryAfter.set(failoverBackoffKey(channelId, excludeUrl), Date.now() + LIVE_FAILOVER_RETRY_BACKOFF_MS);
}
function clearFailoverFailure(channelId, excludeUrl) {
  if (!excludeUrl) return;
  failoverRetryAfter.delete(failoverBackoffKey(channelId, excludeUrl));
}
function isExactDaddyEndpoint(endpoint) {
  return /^daddy:/i.test(String(endpoint?.provider || ""));
}

export function liveStreamEndpoints(channelId, { proxyUrl = config.dlhdProxyUrl, legacyUrl = config.dlhdUrl } = {}) {
  const id = encodeURIComponent(String(channelId || "").replace(/\.(?:m3u8|ts)$/i, ""));
  const endpoints = [];
  if (proxyUrl) endpoints.push({ provider: "amddeus-dlhd-proxy", url: `${String(proxyUrl).replace(/\/$/, "")}/stream/${id}.m3u8` });
  if (legacyUrl) endpoints.push({ provider: "legacy-dlhd-web", url: `${String(legacyUrl).replace(/\/$/, "")}/api/stream/${id}.m3u8` });
  return endpoints;
}

async function discoverLiveStreamEndpoints(channelId, { proxyUrl = config.dlhdProxyUrl, legacyUrl = config.dlhdUrl } = {}) {
  const id = encodeURIComponent(String(channelId || "").replace(/\.(?:m3u8|ts)$/i, ""));
  const endpoints = [];
  if (proxyUrl) {
    const base = String(proxyUrl).replace(/\/$/, "");
    try {
      const response = await fetch(`${base}/candidates/${id}`, { redirect: "follow", signal: AbortSignal.timeout(LIVE_SOURCE_DISCOVERY_TIMEOUT_MS) });
      if (response.ok) {
        const payload = await response.json();
        const rows = Array.isArray(payload?.candidates) ? payload.candidates : [];
        for (const row of rows.slice(0, LIVE_SOURCE_MAX_CANDIDATES)) {
          const family = String(row?.family || "").trim();
          const embed = Number(row?.embed);
          const source = Number(row?.source);
          if (!/^(?:stream|watch|cast|plus|player|casting)$/.test(family)) continue;
          if (!Number.isInteger(embed) || embed < 0 || !Number.isInteger(source) || source < 0) continue;
          endpoints.push({ provider: `daddy:${family}:e${embed + 1}:s${source + 1}`, url: `${base}/candidate/${id}/${family}/${embed}/${source}.m3u8`, candidate: { family, embed, source } });
        }
      }
    } catch { /* stable aggregate route below */ }

    // Keep the aggregate proxy available even when exact candidate discovery
    // succeeds. Exact candidates are valuable for normal tuning/learning, but
    // the aggregate route is a structurally stable tertiary recovery path for
    // an already-established renewable HLS hierarchy.
    endpoints.push({ provider: "amddeus-dlhd-proxy", url: `${base}/stream/${id}.m3u8` });
  }
  if (legacyUrl) endpoints.push({ provider: "legacy-dlhd-web", url: `${String(legacyUrl).replace(/\/$/, "")}/api/stream/${id}.m3u8` });
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
      chunks.push(chunk); total += chunk.length;
      if (value.length > remaining) break;
    }
  } finally { try { await reader.cancel(); } catch {} }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function resolveLiveEndpoint(endpoint) {
  let response;
  try { response = await fetch(endpoint.url, { redirect: "follow", signal: AbortSignal.timeout(LIVE_SOURCE_PROBE_TIMEOUT_MS) }); }
  catch { throw new LiveEndpointError(`${endpoint.provider} transport failed`, { transport: true, provider: endpoint.provider }); }
  if (response.status < 200 || response.status >= 300) {
    try { await response.body?.cancel(); } catch {}
    throw new LiveEndpointError(`${endpoint.provider} returned ${response.status}`, { status: response.status, provider: endpoint.provider });
  }
  const text = await readManifestPrefix(response);
  if (!text.trimStart().startsWith("#EXTM3U")) throw new LiveEndpointError(`${endpoint.provider} returned no HLS manifest`, { status: response.status, invalid: true, provider: endpoint.provider });
  return endpoint.url;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function retryableManagedFailure(endpoint, error) {
  const provider = String(endpoint?.provider || "");
  if (provider !== "amddeus-dlhd-proxy" && !isExactDaddyEndpoint(endpoint)) return false;
  if (error?.transport || error?.invalid) return true;
  return [404, 429, 500, 502, 503, 504].includes(Number(error?.status));
}
async function resolveManagedWithRecovery(endpoint) {
  const aggregate = endpoint?.provider === "amddeus-dlhd-proxy";
  const maxRetries = aggregate ? LIVE_PRIMARY_404_RETRIES : LIVE_CANDIDATE_TRANSIENT_RETRIES;
  const baseDelay = aggregate ? LIVE_PRIMARY_404_RETRY_DELAY_MS : LIVE_CANDIDATE_RETRY_DELAY_MS;
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try { return await resolveLiveEndpoint(endpoint); }
    catch (error) {
      lastError = error;
      if (!retryableManagedFailure(endpoint, error) || attempt >= maxRetries) throw error;
      await sleep(baseDelay * (attempt + 1));
    }
  }
  throw lastError || new Error("managed live resolver failed");
}
async function probeManagedEndpoint(endpoint) {
  if (endpoint?.provider === "amddeus-dlhd-proxy" || isExactDaddyEndpoint(endpoint)) return resolveManagedWithRecovery(endpoint);
  return resolveLiveEndpoint(endpoint);
}

function pickedFromEndpoint(endpoint) {
  return {
    url: endpoint.url, quality: "live", available: ["live"], wanted: "live", matched: true,
    validated: true, playbackValidated: Boolean(endpoint.candidate), liveValidated: true,
    liveValidatedAt: Date.now(), provider: endpoint.provider, candidate: endpoint.candidate || null,
  };
}

function eligibleEndpoints(channelId, discovered, excluded) {
  const nonExcluded = discovered.filter((endpoint) => String(endpoint.url) !== excluded);
  const fresh = nonExcluded.filter((endpoint) => !isSourceQuarantined(channelId, endpoint.url));
  // A quarantine is advisory for alternates: if every remaining candidate has
  // recently failed, qualify them again rather than manufacturing an outage.
  // The explicitly failed root remains hard-excluded for this handoff.
  return fresh.length ? fresh : nonExcluded;
}

async function qualifyHandoff(channelId, endpoints, excluded) {
  const stable = endpoints.filter((endpoint) => !isExactDaddyEndpoint(endpoint));
  const exact = endpoints.filter(isExactDaddyEndpoint);
  let stableError = null;

  // For an established renewable hierarchy, prefer a freshly validated stable
  // aggregate/legacy root. Direct Daddy candidates can legitimately expose a
  // different master/media shape, so use them only when no stable alternate is
  // currently healthy.
  if (stable.length) {
    try {
      return await qualifyLiveSources(channelId, stable, probeManagedEndpoint, { force: true });
    } catch (error) {
      stableError = error;
    }
  }
  if (exact.length) return qualifyLiveSources(channelId, exact, probeManagedEndpoint, { force: true });
  throw stableError || new Error(`no healthy live source candidates after excluding ${excluded}`);
}

async function resolveLiveUncoalesced(channelId, { force, proxyUrl, legacyUrl, excludeUrl }) {
  const key = `live:${channelId}`;
  const excluded = String(excludeUrl || "");

  if (force && excluded) {
    quarantineLiveSource(channelId, excluded);
    const retryAt = activeFailoverBackoff(channelId, excluded);
    if (retryAt) {
      const error = new Error("live source failover cooling down");
      error.retryAfterMs = Math.max(1, retryAt - Date.now());
      throw error;
    }
  } else if (force) {
    // Preserve the old FFmpeg-restart signal for non-renewable forced resolves.
    // Explicit renewable handoffs deliberately avoid this path because stale
    // warm health must not select a replacement before fresh qualification.
    const previous = cacheGet(key);
    if (previous?.url) noteLiveSourceObservation(channelId, previous.url, { ok: false, status: 502 });
  }

  const discovered = await discoverLiveStreamEndpoints(channelId, { proxyUrl, legacyUrl });
  const endpoints = eligibleEndpoints(channelId, discovered, excluded);
  if (!endpoints.length) {
    if (excluded && discovered.length) {
      markFailoverFailure(channelId, excluded);
      throw new Error("no alternate live source candidates");
    }
    throw new Error("no DLHD live provider configured");
  }

  if (force && excluded) {
    try {
      const selected = await qualifyHandoff(channelId, endpoints, excluded);
      const picked = pickedFromEndpoint(selected);
      cacheSet(key, picked);
      clearFailoverFailure(channelId, excluded);
      return picked;
    } catch (error) {
      markFailoverFailure(channelId, excluded);
      throw error;
    }
  }

  if (!force) {
    const preferred = preferredLiveSource(channelId, endpoints, probeManagedEndpoint, { maxAgeMs: LIVE_SOURCE_RECHECK_MS });
    if (preferred) { const picked = pickedFromEndpoint(preferred); cacheSet(key, picked); return picked; }
    const cached = cacheGet(key);
    if (cached?.liveValidatedAt && Date.now() - cached.liveValidatedAt <= LIVE_SOURCE_RECHECK_MS && !isSourceQuarantined(channelId, cached.url)) return cached;
  }
  const selected = await qualifyLiveSources(channelId, endpoints, probeManagedEndpoint, { force });
  const picked = pickedFromEndpoint(selected); cacheSet(key, picked); return picked;
}

export async function resolveLive(
  channelId,
  {
    force = false,
    proxyUrl = config.dlhdProxyUrl,
    legacyUrl = config.dlhdUrl,
    excludeUrl = "",
  } = {},
) {
  const options = { force, proxyUrl, legacyUrl, excludeUrl };
  const operationKey = inFlightKey(channelId, options);
  const existing = inFlight.get(operationKey);
  if (existing) { coalescedJoins += 1; return existing; }
  const task = resolveLiveUncoalesced(channelId, options); inFlight.set(operationKey, task);
  try { return await task; } finally { if (inFlight.get(operationKey) === task) inFlight.delete(operationKey); }
}

export function retainLiveSourceLearning(channelId, { proxyUrl = config.dlhdProxyUrl, legacyUrl = config.dlhdUrl } = {}) {
  const id = String(channelId || "");
  let session = learningSessions.get(id);
  if (!session) {
    session = { refs: 0, releaseManager: null, cancelled: false }; learningSessions.set(id, session);
    void discoverLiveStreamEndpoints(id, { proxyUrl, legacyUrl }).then((endpoints) => {
      if (session.cancelled || !endpoints.length) return;
      session.releaseManager = retainManagerLearning(id, endpoints, probeManagedEndpoint);
    }).catch(() => {});
  }
  session.refs += 1;
  return () => {
    session.refs = Math.max(0, session.refs - 1);
    if (session.refs) return;
    session.cancelled = true; session.releaseManager?.(); learningSessions.delete(id);
  };
}

export function cacheStats() {
  const now = Date.now();
  for (const [key, until] of failedSourceQuarantine) if (until <= now) failedSourceQuarantine.delete(key);
  for (const [key, until] of failoverRetryAfter) if (until <= now) failoverRetryAfter.delete(key);
  return {
    size: cache.size,
    ttlMs: TTL_MS,
    liveSourceProbeTimeoutMs: LIVE_SOURCE_PROBE_TIMEOUT_MS,
    liveSourceRecheckMs: LIVE_SOURCE_RECHECK_MS,
    sourceDiscoveryTimeoutMs: LIVE_SOURCE_DISCOVERY_TIMEOUT_MS,
    sourceMaxCandidates: LIVE_SOURCE_MAX_CANDIDATES,
    primary404Retries: LIVE_PRIMARY_404_RETRIES,
    primary404RetryDelayMs: LIVE_PRIMARY_404_RETRY_DELAY_MS,
    candidateTransientRetries: LIVE_CANDIDATE_TRANSIENT_RETRIES,
    candidateRetryDelayMs: LIVE_CANDIDATE_RETRY_DELAY_MS,
    sourceFailureQuarantineMs: LIVE_SOURCE_FAILURE_QUARANTINE_MS,
    quarantinedSources: failedSourceQuarantine.size,
    failoverRetryBackoffMs: LIVE_FAILOVER_RETRY_BACKOFF_MS,
    failoverBackoffs: failoverRetryAfter.size,
    inFlight: inFlight.size,
    coalescedJoins,
    sourceManager: liveSourceManagerStats(),
  };
}
