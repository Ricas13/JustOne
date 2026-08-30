import { config } from "../config.js";

const BACKGROUND_MIN_INTERVAL_MS = Math.max(
  250,
  Number(process.env.WEBSTREAMR_BACKGROUND_MIN_INTERVAL_MS || 1500),
);
const RATE_LIMIT_FALLBACK_MS = Math.max(
  5000,
  Number(process.env.WEBSTREAMR_RATE_LIMIT_FALLBACK_MS || 60000),
);

let cooldownUntil = 0;
let lastRateLimitAt = null;
let lastRetryAfterMs = 0;
let backgroundNextAt = 0;
let backgroundGate = Promise.resolve();

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function requestHeaders(stream) {
  const raw = stream?.behaviorHints?.proxyHeaders?.request;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw)
      .filter(([key, value]) => key && value != null)
      .map(([key, value]) => [String(key), String(value)]),
  );
}

function normalizeStream(stream) {
  if (!stream || !isHttpUrl(stream.url)) return null;
  return {
    url: String(stream.url),
    quality: stream.quality || stream.resolution || "",
    name: stream.name || "",
    title: stream.title || "",
    type: stream.type || "",
    requestHeaders: requestHeaders(stream),
    provider: "secondary",
    raw: stream,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(value) {
  const raw = String(value || "").trim();
  if (!raw) return RATE_LIMIT_FALLBACK_MS;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1000, seconds * 1000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(1000, date - Date.now());
  return RATE_LIMIT_FALLBACK_MS;
}

function rateLimitError(ms, message = "stream provider rate limited") {
  const error = new Error(message);
  error.code = "WEBSTREAMR_RATE_LIMITED";
  error.retryAfterMs = Math.max(0, Number(ms || 0));
  error.retryAt = new Date(Date.now() + error.retryAfterMs).toISOString();
  return error;
}

function cooldownError() {
  const remaining = Math.max(0, cooldownUntil - Date.now());
  const error = rateLimitError(remaining, "stream provider cooling down after rate limit");
  error.code = "WEBSTREAMR_COOLDOWN";
  return error;
}

function noteRateLimit(response) {
  const waitMs = retryAfterMs(response.headers.get("retry-after"));
  cooldownUntil = Math.max(cooldownUntil, Date.now() + waitMs);
  lastRateLimitAt = new Date().toISOString();
  lastRetryAfterMs = waitMs;
  return waitMs;
}

async function waitForBackgroundSlot() {
  const turn = backgroundGate.then(async () => {
    const wait = Math.max(0, backgroundNextAt - Date.now());
    if (wait) await sleep(wait);
    backgroundNextAt = Date.now() + BACKGROUND_MIN_INTERVAL_MS;
  });
  backgroundGate = turn.catch(() => {});
  await turn;
}

async function fetchStreams(type, id, { background = false } = {}) {
  if (Date.now() < cooldownUntil) throw cooldownError();
  if (background) {
    await waitForBackgroundSlot();
    if (Date.now() < cooldownUntil) throw cooldownError();
  }

  const endpoint = `${config.streamProviderUrl}/stream/${type}/${encodeURIComponent(id)}.json`;
  const response = await fetch(endpoint, {
    headers: {
      accept: "application/json",
      "user-agent": background
        ? "JustOne background catalog auditor"
        : "JustOne source resolver",
    },
    signal: AbortSignal.timeout(config.sourceProviderTimeoutMs),
  });

  if (response.status === 429) {
    const waitMs = noteRateLimit(response);
    try {
      await response.body?.cancel();
    } catch {
      /* ignore */
    }
    throw rateLimitError(waitMs);
  }

  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      /* ignore */
    }
    throw new Error(`stream provider returned ${response.status}`);
  }

  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`stream provider returned non-JSON response (${response.status})`);
  }

  return (Array.isArray(data?.streams) ? data.streams : [])
    .map(normalizeStream)
    .filter(Boolean);
}

export function fetchMovieStreams(tmdbId, options) {
  return fetchStreams("movie", `tmdb:${tmdbId}`, options);
}

export function fetchEpisodeStreams(tmdbId, season, episode, options) {
  return fetchStreams("series", `tmdb:${tmdbId}:${season}:${episode}`, options);
}

export function webStreamrStatus() {
  const remainingMs = Math.max(0, cooldownUntil - Date.now());
  return {
    coolingDown: remainingMs > 0,
    cooldownUntil: remainingMs > 0 ? new Date(cooldownUntil).toISOString() : null,
    remainingMs,
    lastRateLimitAt,
    lastRetryAfterMs,
    backgroundMinIntervalMs: BACKGROUND_MIN_INTERVAL_MS,
  };
}
