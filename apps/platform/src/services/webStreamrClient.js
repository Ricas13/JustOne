import { config } from "../config.js";

const BACKGROUND_MIN_INTERVAL_MS = Math.max(
  250,
  Number(process.env.WEBSTREAMR_BACKGROUND_MIN_INTERVAL_MS || 1500),
);
const INTERACTIVE_GRACE_MS = Math.max(
  0,
  Number(process.env.WEBSTREAMR_INTERACTIVE_GRACE_MS || 2500),
);
const RATE_LIMIT_FALLBACK_MS = Math.max(
  5000,
  Number(process.env.WEBSTREAMR_RATE_LIMIT_FALLBACK_MS || 60000),
);
const PLAYBACK_PROBE_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.PLAYBACK_SOURCE_PROBE_TIMEOUT_MS || 5000),
);
const PLAYBACK_PROBE_BYTES = 4096;
const PLAYBACK_READY_TARGETS = Math.max(
  1,
  Math.min(10, Number(process.env.PLAYBACK_SOURCE_FAILOVER_ATTEMPTS || 4)),
);
const MATERIALIZE_BATCH_SIZE = 4;

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
    for (;;) {
      const wait = Math.max(0, backgroundNextAt - Date.now());
      if (!wait) break;
      await sleep(wait);
    }
    backgroundNextAt = Date.now() + BACKGROUND_MIN_INTERVAL_MS;
  });
  backgroundGate = turn.catch(() => {});
  await turn;
}

function isLazyExtractUrl(value) {
  try {
    const url = new URL(String(value));
    const provider = new URL(config.streamProviderUrl);
    return url.origin === provider.origin && /\/extract\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function qualityBucket(stream) {
  const text = `${stream?.quality || ""} ${stream?.name || ""} ${stream?.title || ""}`.toLowerCase();
  if (/2160|\b4k\b|\buhd\b|3840/.test(text)) return "4k";
  if (/1080/.test(text)) return "1080p";
  if (/720/.test(text)) return "720p";
  if (/480|360|240/.test(text)) return "sd";
  return "unknown";
}

async function readPrefix(response, maxBytes = PLAYBACK_PROBE_BYTES) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      const take = value.subarray(0, Math.min(value.length, maxBytes - total));
      chunks.push(take);
      total += take.length;
      if (take.length < value.length) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore cleanup errors */
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function playbackErrorPayload(response, prefix) {
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const text = new TextDecoder().decode(prefix).trim();
  const lower = text.toLowerCase();

  if (
    /downloadquotaexceeded|download quota(?: for this file)? has been exceeded|"domain"\s*:\s*"usagelimits"|quota[_ -]?exceeded/.test(
      lower,
    )
  ) {
    return true;
  }

  const jsonLike = contentType.includes("json") || /^[{[]/.test(text);
  if (jsonLike && /["']error["']\s*:|["']errors["']\s*:/.test(lower)) return true;

  if (
    contentType.includes("text/html") &&
    /(?:access denied|forbidden|quota|expired|not found|error)/i.test(text)
  ) {
    return true;
  }

  return false;
}

async function materializeLazyStream(stream) {
  if (!isLazyExtractUrl(stream.url)) return stream;

  const headers = {
    accept: "*/*",
    "user-agent": "JustOne playback source materializer",
    ...stream.requestHeaders,
  };
  if (!Object.keys(headers).some((key) => key.toLowerCase() === "range")) {
    headers.Range = `bytes=0-${PLAYBACK_PROBE_BYTES - 1}`;
  }

  try {
    const response = await fetch(stream.url, {
      method: "GET",
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(PLAYBACK_PROBE_TIMEOUT_MS),
    });
    if (response.status < 200 || response.status >= 400) {
      try {
        await response.body?.cancel();
      } catch {
        /* ignore cleanup errors */
      }
      return null;
    }

    const prefix = await readPrefix(response);
    if (playbackErrorPayload(response, prefix)) return null;

    const finalUrl = isHttpUrl(response.url) ? response.url : stream.url;
    return {
      ...stream,
      url: finalUrl,
      materializedFrom: stream.url,
    };
  } catch {
    return null;
  }
}

async function materializeInteractiveStreams(rows) {
  const lazyTotals = new Map();
  for (const row of rows) {
    if (!isLazyExtractUrl(row.url)) continue;
    const bucket = qualityBucket(row);
    lazyTotals.set(bucket, (lazyTotals.get(bucket) || 0) + 1);
  }
  if (!lazyTotals.size) return rows;

  const targets = new Map(
    [...lazyTotals].map(([bucket, count]) => [bucket, Math.min(PLAYBACK_READY_TARGETS, count)]),
  );
  const ready = new Map();
  const out = [];

  for (let offset = 0; offset < rows.length; offset += MATERIALIZE_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + MATERIALIZE_BATCH_SIZE);
    const resolved = await Promise.all(
      batch.map((row) => (isLazyExtractUrl(row.url) ? materializeLazyStream(row) : Promise.resolve(row))),
    );

    for (let i = 0; i < resolved.length; i += 1) {
      const before = batch[i];
      const after = resolved[i];
      if (!after) continue;
      out.push(after);
      if (isLazyExtractUrl(before.url)) {
        const bucket = qualityBucket(before);
        ready.set(bucket, (ready.get(bucket) || 0) + 1);
      }
    }

    const satisfied = [...targets].every(
      ([bucket, target]) => (ready.get(bucket) || 0) >= target,
    );
    if (satisfied) {
      out.push(
        ...rows
          .slice(offset + batch.length)
          .filter((row) => !isLazyExtractUrl(row.url)),
      );
      break;
    }
  }

  return out;
}

async function fetchStreams(type, id, { background = false } = {}) {
  if (Date.now() < cooldownUntil) throw cooldownError();
  if (background) {
    await waitForBackgroundSlot();
    if (Date.now() < cooldownUntil) throw cooldownError();
  } else if (INTERACTIVE_GRACE_MS) {
    backgroundNextAt = Math.max(backgroundNextAt, Date.now() + INTERACTIVE_GRACE_MS);
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

  const rows = (Array.isArray(data?.streams) ? data.streams : [])
    .map(normalizeStream)
    .filter(Boolean);
  return background ? rows : materializeInteractiveStreams(rows);
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
    interactiveGraceMs: INTERACTIVE_GRACE_MS,
  };
}
